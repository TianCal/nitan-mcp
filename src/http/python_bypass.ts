import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";
import type { Logger } from "../util/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Extra time on top of the per-request timeout before the worker is considered hung.
// The first request on a fresh worker also pays for the session warm-up GET.
const WORKER_GRACE_MS = 20_000;
const STDERR_TAIL_CHARS = 4_000;
// Must match RESPONSE_PREFIX in the Python wrappers.
const RESPONSE_PREFIX = "@@NITAN@@";

export interface BypassRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  cookies?: Record<string, string>;
  timeout?: number;
  login?: {
    username: string;
    password: string;
    second_factor_token?: string;
  };
}

export interface BypassResponse {
  success: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  cookies?: Record<string, string>;
  csrf_token?: string;
  logged_in?: boolean;
  error?: string;
  error_type?: string;
}

function findPythonScript(scriptName: string): string {
  if (isAbsolute(scriptName)) return scriptName;
  // dist/http/<script> (built package) or src/http/<script> (running from a checkout)
  const candidates = [
    join(__dirname, scriptName),
    join(__dirname, "..", "..", "src", "http", scriptName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${scriptName} not found. Please ensure the Python script is bundled with the package.`);
}

interface PendingRequest {
  resolve: (value: BypassResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Talks to a long-lived Python helper (`<wrapper>.py --serve`) over newline-delimited JSON.
 * Keeping one process alive preserves the Python-side HTTP session (Cloudflare cookies,
 * CSRF token, TLS connection) across requests and avoids a process spawn + warm-up GET per call.
 * Requests are processed by the worker in order, so responses are matched FIFO.
 */
export class PythonBypassClient {
  private readonly scriptPath: string;
  private proc?: ChildProcessWithoutNullStreams;
  private pending: PendingRequest[] = [];
  private stderrTail = "";

  constructor(
    private readonly logger: Logger,
    private readonly label: string,
    scriptName: string,
    private readonly pythonPath: string = "python3",
  ) {
    this.scriptPath = findPythonScript(scriptName);
  }

  async request(req: BypassRequest): Promise<BypassResponse> {
    const proc = this.ensureWorker();
    const timeoutMs = (req.timeout ?? 30) * 1000 + WORKER_GRACE_MS;
    return new Promise<BypassResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.logger.error(`${this.label} worker did not respond within ${timeoutMs}ms; restarting it`);
        this.killWorker(new Error(`${this.label} worker timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.push({ resolve, reject, timer });
      proc.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  async dispose(): Promise<void> {
    this.killWorker(new Error(`${this.label} worker disposed`));
  }

  private ensureWorker(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.proc;

    this.logger.debug(`Starting ${this.label} worker: ${this.pythonPath} ${this.scriptPath} --serve`);
    const proc = spawn(this.pythonPath, [this.scriptPath, "--serve"], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    this.stderrTail = "";

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    // Writing to a worker that already exited (e.g. missing Python deps) raises EPIPE here;
    // the pending request is rejected by the "close" handler instead.
    proc.stdin.on("error", (err) => this.logger.debug(`${this.label} worker stdin error: ${err.message}`));

    createInterface({ input: proc.stdout }).on("line", (line) => {
      if (!line.startsWith(RESPONSE_PREFIX)) {
        if (line.trim()) this.logger.debug(`[${this.label} stdout] ${line.slice(0, 200)}`);
        return;
      }
      const next = this.pending.shift();
      if (!next) {
        this.logger.debug(`${this.label} worker sent a response with no pending request`);
        return;
      }
      clearTimeout(next.timer);
      try {
        const result = JSON.parse(line.slice(RESPONSE_PREFIX.length)) as BypassResponse;
        if (!result.success) {
          this.logger.error(`${this.label} error: ${result.error} (${result.error_type})`);
        }
        next.resolve(result);
      } catch (e: any) {
        next.reject(new Error(`Failed to parse ${this.label} response: ${e?.message || String(e)}`));
      }
    });

    createInterface({ input: proc.stderr }).on("line", (line) => {
      this.stderrTail = (this.stderrTail + line + "\n").slice(-STDERR_TAIL_CHARS);
      this.logger.debug(`[${this.label}] ${line}`);
    });

    proc.on("error", (err) => {
      this.logger.error(`Failed to spawn Python for ${this.label}: ${err.message}. Make sure '${this.pythonPath}' exists (see --python-path).`);
      this.failPending(new Error(`Failed to spawn Python (${this.label}): ${err.message}`));
      if (this.proc === proc) this.proc = undefined;
    });

    proc.on("close", (code) => {
      if (this.proc === proc) this.proc = undefined;
      if (this.pending.length === 0) return;
      this.failPending(new Error(this.describeExit(code)));
    });

    return proc;
  }

  private describeExit(code: number | null): string {
    if (/ModuleNotFoundError|ImportError/.test(this.stderrTail)) {
      return `Python dependencies missing for ${this.label}. Run: "${this.pythonPath}" -m pip install -r requirements.txt`;
    }
    const tail = this.stderrTail.trim().split("\n").slice(-5).join("\n");
    return `${this.label} worker exited with code ${code}${tail ? `: ${tail}` : ""}`;
  }

  private failPending(err: Error) {
    const pending = this.pending;
    this.pending = [];
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  private killWorker(err: Error) {
    const proc = this.proc;
    this.proc = undefined;
    this.failPending(err);
    if (proc && proc.exitCode === null) {
      proc.stdin.end();
      proc.kill("SIGTERM");
    }
  }
}
