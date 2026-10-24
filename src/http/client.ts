import { Logger } from "../util/logger.js";
import { redactHeaders } from "../util/redact.js";
import { PythonBypassClient, type BypassRequest, type BypassResponse } from "./python_bypass.js";
import {
  BrowserFallbackClient,
  BrowserFallbackRelayUnavailableError,
  type BrowserFallbackOptions,
} from "./browser_fallback.js";

export type AuthMode =
  | { type: "none" }
  | { type: "api_key"; key: string; username?: string }
  | { type: "user_api_key"; key: string; client_id?: string };

export type BypassMethod = "cloudscraper" | "curl_cffi" | "both";

export interface HttpClientOptions {
  baseUrl: string;
  timeoutMs: number;
  logger: Logger;
  auth: AuthMode;
  useCloudscraper?: boolean; // Use Python cloudscraper to bypass Cloudflare (deprecated, use bypassMethod)
  bypassMethod?: BypassMethod; // Which bypass method to use: "cloudscraper", "curl_cffi", or "both" (fallback)
  pythonPath?: string; // Path to Python executable (default: "python3")
  loginCredentials?: {
    username: string;
    password: string;
    second_factor_token?: string;
  };
  browserFallback?: BrowserFallbackOptions;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = "HttpError";
  }
}

// In "both" mode, a failing cloudscraper is skipped for this long before it is tried again.
const CLOUDSCRAPER_COOLDOWN_MS = 5 * 60 * 1000;

export class HttpClient {
  private base: URL;
  // Used by the native fetch path only; the Python helpers send the User-Agent that
  // matches their own TLS fingerprint.
  private userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  private cookies = new Map<string, string>(); // Store cookies across requests
  private lastUrl: string | null = null; // Track last URL for Referer header
  private cloudscraperClient?: PythonBypassClient;
  private curlCffiClient?: PythonBypassClient;
  private bypassMethod: BypassMethod;
  private cloudscraperRetryAt = 0; // While in the future, "both" mode skips cloudscraper
  private browserFallbackClient?: BrowserFallbackClient;

  constructor(private opts: HttpClientOptions) {
    this.base = new URL(opts.baseUrl);

    // Determine bypass method (support legacy useCloudscraper option)
    if (opts.bypassMethod) {
      this.bypassMethod = opts.bypassMethod;
    } else if (opts.useCloudscraper) {
      // Legacy: if useCloudscraper is true, default to "both" for better reliability
      this.bypassMethod = "both";
    } else {
      this.bypassMethod = "both"; // Default to both with fallback
    }

    // Initialize bypass clients based on method
    if (this.bypassMethod === "cloudscraper" || this.bypassMethod === "both") {
      this.cloudscraperClient = new PythonBypassClient(opts.logger, "cloudscraper", "cloudscraper_wrapper.py", opts.pythonPath);
      this.opts.logger.info("Cloudscraper initialized for Cloudflare bypass");
    }
    if (this.bypassMethod === "curl_cffi" || this.bypassMethod === "both") {
      this.curlCffiClient = new PythonBypassClient(opts.logger, "curl_cffi", "curl_cffi_wrapper.py", opts.pythonPath);
      this.opts.logger.info("curl_cffi initialized for Cloudflare bypass");
    }

    // Log the active bypass strategy
    if (this.bypassMethod === "both") {
      this.opts.logger.info("Using dual bypass strategy: cloudscraper with curl_cffi fallback");
    }

    if (opts.browserFallback?.enabled) {
      this.browserFallbackClient = new BrowserFallbackClient(this.opts.logger, opts.browserFallback);
      this.opts.logger.info("Browser fallback enabled");
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      "Dnt": "1",
      "Pragma": "no-cache",
      "Priority": "u=1, i",
      "Sec-Ch-Ua": '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": this.userAgent,
      "X-Requested-With": "XMLHttpRequest",
    };

    // Add Referer header for subsequent requests
    if (this.lastUrl) {
      h["Referer"] = `${this.base.origin}/`;
    }

    // Add cookies if we have any
    if (this.cookies.size > 0) {
      h["Cookie"] = Array.from(this.cookies.entries())
        .map(([key, value]) => `${key}=${value}`)
        .join("; ");
      this.opts.logger.debug(`Using ${this.cookies.size} cookies in request`);
    }

    if (this.opts.auth.type === "api_key") {
      h["Api-Key"] = this.opts.auth.key;
      if (this.opts.auth.username) h["Api-Username"] = this.opts.auth.username;
    } else if (this.opts.auth.type === "user_api_key") {
      h["User-Api-Key"] = this.opts.auth.key;
      if (this.opts.auth.client_id) h["User-Api-Client-Id"] = this.opts.auth.client_id;
    }
    return h;
  }

  private parseCookies(setCookieHeader: string) {
    // Parse Set-Cookie header and store cookies
    // Handle multiple Set-Cookie headers (split by comma, but be careful with expires dates)
    const cookies = setCookieHeader.split(/,(?=[^ ])/);
    for (const cookie of cookies) {
      const parts = cookie.split(";")[0].trim(); // Get only the name=value part
      const [name, ...valueParts] = parts.split("=");
      if (name && valueParts.length > 0) {
        const value = valueParts.join("=");
        this.cookies.set(name.trim(), value.trim());
        this.opts.logger.debug(`Stored cookie: ${name.trim()}`);
      }
    }
  }

  async get(path: string, { signal }: { signal?: AbortSignal } = {}) {
    return this.request("GET", path, undefined, { signal });
  }

  async post(path: string, body: unknown, { signal }: { signal?: AbortSignal } = {}) {
    return this.request("POST", path, body, { signal });
  }

  private async request(method: string, path: string, body?: unknown, { signal }: { signal?: AbortSignal } = {}) {
    const url = new URL(path, this.base).toString();
    const headers = this.headers();
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    this.opts.logger.debug(`HTTP ${method} ${url}`);
    this.opts.logger.debug(`Request headers: ${JSON.stringify(redactHeaders(headers), null, 2)}`);

    // Use bypass method if configured; if bypass runtime is unavailable, gracefully fall back to native fetch
    if (this.cloudscraperClient || this.curlCffiClient) {
      try {
        return await withRetries(() => this.requestViaBypass(method, url, headers, body), this.opts.logger, url, method);
      } catch (e: any) {
        if (e instanceof BrowserFallbackRelayUnavailableError) {
          throw e;
        }
        if (e instanceof HttpError) {
          throw e;
        }
        this.opts.logger.info(`Bypass path failed, falling back to native fetch: ${e?.message || String(e)}`);
      }
    }

    const attempt = async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      const combinedSignal = mergeSignals([signal, controller.signal]);
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: combinedSignal,
        });

        this.opts.logger.debug(`HTTP ${method} ${url} -> ${res.status} ${res.statusText}`);

        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        this.opts.logger.debug(`Response headers: ${JSON.stringify(redactHeaders(responseHeaders), null, 2)}`);

        // Store cookies from response
        const setCookie = res.headers.get("set-cookie");
        if (setCookie) {
          this.parseCookies(setCookie);
        }

        // Update last URL for Referer header
        this.lastUrl = url;

        if (!res.ok) {
          const text = await safeText(res);
          const errorBody = safeJson(text);
          const isChallenge = this.isCloudflareChallenge(res.status, text, responseHeaders);
          if (isChallenge && this.browserFallbackClient?.isEnabled()) {
            this.opts.logger.info(`Cloudflare challenge detected via native fetch (${res.status}), switching to browser fallback`);
            return await this.tryBrowserFallback(method, url, headers, body);
          }
          this.opts.logger.error(`HTTP ${res.status} ${res.statusText} for ${method} ${url}: ${text.slice(0, 500)}`);
          throw new HttpError(res.status, `HTTP ${res.status} ${res.statusText}`, errorBody);
        }
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          return res.json();
        } else {
          return res.text();
        }
      } catch (e: any) {
        // Enhanced error logging for fetch failures
        if (e instanceof HttpError) {
          throw e; // Already logged above
        }

        // Check for common fetch failure reasons
        if (e.name === "AbortError") {
          const timeoutMsg = `Request timeout after ${this.opts.timeoutMs}ms for ${method} ${url}`;
          this.opts.logger.error(timeoutMsg);
          throw new Error(timeoutMsg);
        }

        if (e.name === "TypeError" && e.message === "fetch failed") {
          const detailedMsg = `Network error for ${method} ${url}: ${e.message}. Possible causes: DNS resolution failure, network connectivity issue, SSL/TLS error, or server unreachable.`;
          this.opts.logger.error(detailedMsg);
          if (e.cause) {
            this.opts.logger.error(`Underlying cause: ${String(e.cause)}`);
          }
          throw new Error(detailedMsg);
        }

        // Generic network error
        const genericMsg = `Fetch error for ${method} ${url}: ${e.name}: ${e.message}`;
        this.opts.logger.error(genericMsg);
        if (e.cause) {
          this.opts.logger.error(`Cause: ${String(e.cause)}`);
        }
        if (e.stack) {
          this.opts.logger.debug(`Stack: ${e.stack}`);
        }
        throw new Error(`${e.name}: ${e.message}`);
      } finally {
        clearTimeout(timeout);
      }
    };

    return await withRetries(attempt, this.opts.logger, url, method);
  }

  // Cloudflare challenge pages are HTML. JSON and the text/plain /raw/ endpoint carry forum
  // content, which may legitimately contain phrases like "just a moment".
  private isCloudflareChallenge(status: number | undefined, bodyText: string | undefined, headers: Record<string, string> | undefined): boolean {
    const contentType = getHeader(headers, "content-type").toLowerCase();
    if (contentType.includes("json") || contentType.includes("text/plain")) {
      return false;
    }

    const body = bodyText || "";
    const isHtml = contentType.includes("html") || /^\s*</.test(body);
    if (!isHtml) {
      return false;
    }

    const cfHeaderHit = Boolean(
      getHeader(headers, "cf-ray") ||
      getHeader(headers, "cf-mitigated") ||
      getHeader(headers, "server").toLowerCase().includes("cloudflare")
    );

    const lower = body.toLowerCase();
    const strongMarker =
      lower.includes("/cdn-cgi/challenge-platform/") ||
      lower.includes("cf-challenge") ||
      lower.includes("cf_chl_opt");
    const weakMarker =
      lower.includes("just a moment") ||
      lower.includes("attention required");

    const statusHit = status === 403 || status === 429 || status === 503;
    return strongMarker || (statusHit && (cfHeaderHit || weakMarker));
  }

  private isLoginRequired(finalUrl: string | undefined, bodyText: string | undefined): boolean {
    let path = "";
    try {
      path = new URL(finalUrl || "").pathname.toLowerCase();
    } catch {
      // ignore unparsable URLs
    }
    if (path === "/login" || path.startsWith("/login/") || path === "/session/sso") {
      return true;
    }
    // A login form is an HTML page with a password field; JSON/text bodies are forum data.
    const b = bodyText || "";
    return /^\s*</.test(b) && /<input[^>]+(name|type)="password"/i.test(b);
  }

  private async tryBrowserFallback(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<any> {
    if (!this.browserFallbackClient?.isEnabled()) {
      return undefined;
    }

    const browserRequest = {
      url,
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };

    this.opts.logger.info(`Attempting browser fallback for ${method} ${url}`);
    let response = await this.browserFallbackClient.request(browserRequest);

    if (this.isLoginRequired(response.finalUrl, response.body)) {
      if (!this.opts.loginCredentials) {
        throw new Error(
          this.opts.auth.type === "none"
            ? "Authentication required. Configure an API key or provide NITAN_USERNAME/NITAN_PASSWORD."
            : "The site asked for login even though an API key is configured; the key may be revoked. Run `nitan-mcp generate-user-api-key` to create a new one."
        );
      }

      const autoLoginAttempted = await this.browserFallbackClient.maybeAutoLogin(this.base.toString());
      if (autoLoginAttempted) {
        this.opts.logger.info(`Retrying browser fallback once after auto-login for ${method} ${url}`);
        response = await this.browserFallbackClient.request(browserRequest);
      }

      if (this.isLoginRequired(response.finalUrl, response.body)) {
        await this.browserFallbackClient.maybePromptInteractiveLogin(this.base.toString());
      }
    }

    const contentType = getHeader(response.headers, "content-type");
    if (response.status >= 400) {
      const err = new HttpError(response.status, `Browser fallback HTTP ${response.status}`, safeJson(response.body || ""));
      // Relaunching the browser for every retry is slow and rarely helps.
      (err as any).noRetry = true;
      throw err;
    }

    if (contentType.includes("application/json")) {
      return JSON.parse(response.body || "{}");
    }

    const maybeJson = safeJson(response.body || "");
    return typeof maybeJson === "string" ? response.body : maybeJson;
  }

  private async requestViaBypass(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<any> {
    const cookiesObj: Record<string, string> = Object.fromEntries(this.cookies);
    this.opts.logger.debug(`Sending ${Object.keys(cookiesObj).length} cookies to bypass: ${Object.keys(cookiesObj).join(", ")}`);

    const requestData: BypassRequest = {
      url,
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cookies: cookiesObj,
      timeout: Math.floor(this.opts.timeoutMs / 1000), // Convert to seconds
    };

    // Add login credentials if provided
    if (this.opts.loginCredentials) {
      requestData.login = this.opts.loginCredentials;
      this.opts.logger.debug(`Including login credentials for ${this.opts.loginCredentials.username}`);
    }

    // Strategy: Try cloudscraper first (if available), fallback to curl_cffi
    let lastError: Error | null = null;

    const cloudscraperCoolingDown = this.bypassMethod === "both" && Date.now() < this.cloudscraperRetryAt;
    if (this.cloudscraperClient && !cloudscraperCoolingDown) {
      try {
        const result = await this.cloudscraperClient.request(requestData);
        const value = await this.handleBypassResult("cloudscraper", result, method, url, headers, body);
        this.cloudscraperRetryAt = 0;
        return value;
      } catch (e: any) {
        if (e instanceof BrowserFallbackRelayUnavailableError || e instanceof HttpError) {
          throw e; // Don't fall back on HTTP errors (4xx, 5xx)
        }

        lastError = e;
        this.opts.logger.info(`Cloudscraper failed: ${e.message}`);

        if (this.bypassMethod === "cloudscraper") {
          const errorMsg = `Cloudscraper request failed: ${e.message}`;
          this.opts.logger.error(errorMsg);
          throw new Error(errorMsg);
        }

        this.cloudscraperRetryAt = Date.now() + CLOUDSCRAPER_COOLDOWN_MS;
        this.opts.logger.info(`Skipping cloudscraper for ${CLOUDSCRAPER_COOLDOWN_MS / 60000} minutes; falling back to curl_cffi...`);
      }
    }

    if (this.curlCffiClient) {
      try {
        const result = await this.curlCffiClient.request(requestData);
        return await this.handleBypassResult("curl_cffi", result, method, url, headers, body);
      } catch (e: any) {
        if (e instanceof BrowserFallbackRelayUnavailableError || e instanceof HttpError) {
          throw e;
        }

        const errorMsg = `curl_cffi request failed: ${e.message}`;
        this.opts.logger.error(errorMsg);

        // If we had a previous cloudscraper error, mention both
        if (lastError) {
          this.opts.logger.error(`Both bypass methods failed. Cloudscraper: ${lastError.message}, curl_cffi: ${e.message}`);
          throw new Error(`Both bypass methods failed. Last error: ${e.message}`);
        }

        throw new Error(errorMsg);
      }
    }

    if (lastError) throw lastError;
    // This should never happen if configuration is correct
    throw new Error("No bypass method available");
  }

  private async handleBypassResult(
    label: string,
    result: BypassResponse,
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<any> {
    if (!result.success) {
      throw new Error(`${label} error: ${result.error} (${result.error_type})`);
    }

    this.opts.logger.debug(`${label} ${method} ${url} -> ${result.status}`);

    if (result.cookies) {
      for (const [key, value] of Object.entries(result.cookies)) {
        this.cookies.set(key, value);
      }
    }

    // Update last URL for Referer header
    this.lastUrl = url;

    if (this.isCloudflareChallenge(result.status, result.body, result.headers)) {
      if (this.browserFallbackClient?.isEnabled()) {
        this.opts.logger.info(`Cloudflare challenge detected via ${label} (${result.status}), switching to browser fallback`);
        return await this.tryBrowserFallback(method, url, headers, body);
      }
      // Not an HttpError, so the next bypass method still gets a chance.
      throw new Error(`${label} was served a Cloudflare challenge (HTTP ${result.status})`);
    }

    if (result.status && result.status >= 400) {
      this.opts.logger.error(`HTTP ${result.status} for ${method} ${url}: ${(result.body || "").slice(0, 500)}`);
      throw new HttpError(result.status, `HTTP ${result.status}`, safeJson(result.body || ""));
    }

    if (getHeader(result.headers, "content-type").includes("application/json")) {
      return JSON.parse(result.body || "{}");
    }
    return result.body;
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([
      this.cloudscraperClient?.dispose(),
      this.curlCffiClient?.dispose(),
    ]);
    if (!this.browserFallbackClient) return;
    try {
      await this.browserFallbackClient.dispose();
    } catch (e: any) {
      this.opts.logger.debug(`Failed to dispose browser fallback client cleanly: ${e?.message || String(e)}`);
    }
  }
}

async function withRetries<T>(fn: () => Promise<T>, logger: Logger, url: string, method: string, retries = 3): Promise<T> {
  let attempt = 0;
  let delay = 500;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (e: any) {
      const status = e?.status as number | undefined;
      if (attempt < retries - 1 && !e?.noRetry && (status === 429 || (status && status >= 500))) {
        attempt++;
        logger.info(`Retrying ${method} ${url} (attempt ${attempt}/${retries - 1}) after ${delay}ms due to ${status || 'error'}`);
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      // Log final failure
      if (attempt > 0) {
        logger.error(`Request failed after ${attempt + 1} attempts: ${method} ${url}`);
      }
      throw e;
    }
  }
}

function getHeader(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return "";
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return String(value);
  }
  return "";
}

function mergeSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
