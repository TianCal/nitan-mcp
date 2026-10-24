import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HttpClient } from '../http/client.js';
import { PythonBypassClient } from '../http/python_bypass.js';
import { Logger } from '../util/logger.js';
import { redactHeaders } from '../util/redact.js';
import { parseRawPage } from '../util/raw_topic.js';
import { tagNames } from '../tools/categories.js';
import { registerReadTopic } from '../tools/builtin/read_topic.js';
import { registerListHotTopics } from '../tools/builtin/list_hot_topics.js';
import { registerSearch } from '../tools/builtin/search.js';

const SEP = '\n\n-------------------------\n\n';

function newClient(overrides: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  return new HttpClient({
    baseUrl: 'https://www.uscardforum.com',
    timeoutMs: 5_000,
    logger: new Logger('silent'),
    auth: { type: 'none' },
    bypassMethod: 'both',
    ...overrides,
  });
}

function captureTool(register: Function, ctx: any) {
  let handler: Function | undefined;
  register({ registerTool(_name: string, _meta: any, h: Function) { handler = h; } }, ctx, {});
  return handler!;
}

function fakeCtx(get: (url: string) => Promise<any>, extra: Record<string, unknown> = {}) {
  return {
    siteState: { ensureSelectedSite: () => ({ base: 'https://www.uscardforum.com', client: { get } }) },
    logger: new Logger('silent'),
    maxReadLength: 50000,
    ...extra,
  } as any;
}

test('Cloudflare detection ignores forum content that mentions challenge phrases', () => {
  const client = newClient() as any;
  // JSON and text/plain (/raw/) bodies are forum data, whatever they say.
  assert.equal(client.isCloudflareChallenge(200, '{"raw":"Just a moment, attention required"}', { 'content-type': 'application/json' }), false);
  assert.equal(client.isCloudflareChallenge(200, 'user | date | #1\n\njust a moment', { 'Content-Type': 'text/plain; charset=utf-8' }), false);
  assert.equal(client.isCloudflareChallenge(403, '{"errors":["just a moment"]}', { 'content-type': 'application/json', server: 'cloudflare' }), false);
  // Real challenge pages are HTML.
  assert.equal(client.isCloudflareChallenge(403, '<!DOCTYPE html><title>Just a moment...</title>', { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }), true);
  assert.equal(client.isCloudflareChallenge(200, '<html><script src="/cdn-cgi/challenge-platform/h/b"></script></html>', { 'content-type': 'text/html' }), true);
  // An ordinary HTML 200 page that happens to say "just a moment" is not a challenge.
  assert.equal(client.isCloudflareChallenge(200, '<html><p>just a moment</p></html>', { 'content-type': 'text/html' }), false);
});

test('login detection needs a login URL or an HTML password form', () => {
  const client = newClient() as any;
  assert.equal(client.isLoginRequired('https://www.uscardforum.com/t/123.json', '{"raw":"please log in to see this"}'), false);
  assert.equal(client.isLoginRequired('https://www.uscardforum.com/raw/1', 'a | b | #1\n\nname="password" in a code block'), false);
  assert.equal(client.isLoginRequired('https://www.uscardforum.com/login', ''), true);
  assert.equal(client.isLoginRequired('https://www.uscardforum.com/x', '<form><input type="password" name="password"></form>'), true);
});

test('browser fallback with an API key but no password explains the key may be revoked', async () => {
  const client = newClient({
    auth: { type: 'user_api_key', key: 'k' },
    browserFallback: { enabled: true, provider: 'playwright' },
  }) as any;
  client.browserFallbackClient = {
    isEnabled: () => true,
    request: async () => ({ status: 200, body: '', headers: {}, finalUrl: 'https://www.uscardforum.com/login' }),
  };
  await assert.rejects(client.tryBrowserFallback('GET', 'https://www.uscardforum.com/x.json', {}), /API key.*revoked/);
  client.browserFallbackClient = undefined;
  await client.dispose();
});

test('cloudscraper failure only pauses it for a cooldown instead of disabling it forever', async () => {
  const client = newClient() as any;
  let cloudscraperCalls = 0;
  let curlCalls = 0;
  client.cloudscraperClient = { request: async () => { cloudscraperCalls++; throw new Error('timeout'); }, dispose: async () => {} };
  client.curlCffiClient = { request: async () => { curlCalls++; return { success: true, status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":1}' }; }, dispose: async () => {} };

  assert.deepEqual(await client.get('/a.json'), { ok: 1 });
  assert.deepEqual(await client.get('/b.json'), { ok: 1 });
  assert.equal(cloudscraperCalls, 1, 'skipped during cooldown');

  client.cloudscraperRetryAt = Date.now() - 1; // cooldown elapsed
  await client.get('/c.json');
  assert.equal(cloudscraperCalls, 2, 'tried again after cooldown');
  assert.equal(curlCalls, 3);
});

test('bypass path retries 5xx responses', async () => {
  const client = newClient({ bypassMethod: 'curl_cffi' }) as any;
  let calls = 0;
  client.curlCffiClient = {
    request: async () => {
      calls++;
      return calls < 2
        ? { success: true, status: 502, headers: { 'content-type': 'text/plain' }, body: 'bad gateway' }
        : { success: true, status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
    },
    dispose: async () => {},
  };
  assert.deepEqual(await client.get('/x.json'), { ok: true });
  assert.equal(calls, 2);
});

test('redactHeaders hides credentials and cookies', () => {
  const out = redactHeaders({ 'User-Api-Key': 'secret', Cookie: '_t=abc', Accept: 'application/json' });
  assert.deepEqual(out, { 'User-Api-Key': '<redacted>', Cookie: '<redacted>', Accept: 'application/json' });
});

test('parseRawPage keeps dashed lines and header-like lines inside post bodies', () => {
  const page =
    'alice | 2026-10-24 16:16:19 UTC | #1\n\nhello\n\n-------------------------\n\nnot a separator\nfoo | bar | #99 is just text' +
    SEP +
    'bob | 2026-10-24 16:20:00 UTC | #3\n\nsecond post' +
    SEP;
  const posts = parseRawPage(page);
  assert.deepEqual(posts.map((p) => [p.number, p.username]), [[1, 'alice'], [3, 'bob']]);
  assert.match(posts[0].content, /-{25}\n\nnot a separator\nfoo \| bar \| #99 is just text$/);
  assert.equal(posts[1].content, 'second post');
});

test('tagNames accepts both object and string tags', () => {
  assert.deepEqual(tagNames([{ id: 1, name: 'amex', slug: 'amex' }, 'chase', null]), ['amex', 'chase']);
  assert.deepEqual(tagNames(undefined), []);
});

test('read_topic caps total output and says where to continue', async () => {
  const rawPage = [1, 2, 3, 4].map((n) => `user${n} | 2026-10-24 16:00:0${n} UTC | #${n}\n\n${'x'.repeat(40)}`).join(SEP) + SEP;
  const handler = captureTool(registerReadTopic, fakeCtx(async (url) => {
    if (url === '/t/42.json') return { title: 'T', slug: 't', category_id: 0, tags: [{ name: 'amex' }], posts_count: 4, highest_post_number: 4 };
    if (url === '/raw/42?page=1') return rawPage;
    return '';
  }, { maxReadLength: 100 }));

  const res = await handler({ topic_id: 42 }, {});
  const text = String(res.content[0].text);
  assert.match(text, /Tags: amex/);
  assert.match(text, /Post #2/);
  assert.doesNotMatch(text, /Post #3/);
  assert.match(text, /Continue with start_post_number=3/);
});

test('read_topic stops when a page repeats instead of duplicating posts', async () => {
  const page = 'a | 2026-10-24 16:00:00 UTC | #1\n\none' + SEP + 'b | 2026-10-24 16:00:01 UTC | #2\n\ntwo' + SEP;
  let rawCalls = 0;
  const handler = captureTool(registerReadTopic, fakeCtx(async (url) => {
    if (url === '/t/7.json') return { title: 'T', slug: 't', posts_count: 2, highest_post_number: 2 };
    rawCalls++;
    return page; // every page number returns the same content
  }));
  const text = String((await handler({ topic_id: 7 }, {})).content[0].text);
  assert.equal((text.match(/Post #1 /g) || []).length, 1);
  assert.ok(rawCalls <= 2);
});

test('hot topics skip pinned topics', async () => {
  const handler = captureTool(registerListHotTopics, fakeCtx(async () => ({
    topic_list: { topics: [
      { id: 7, title: 'Rules', slug: 'rules', pinned: true, pinned_globally: true },
      { id: 8, title: 'Hot', slug: 'hot', tags: [{ name: 'gc' }] },
    ] },
  })));
  const items = JSON.parse(String((await handler({ limit: 10 }, {})).content[0].text));
  assert.deepEqual(items.map((t: any) => t.id), [8]);
  assert.deepEqual(items[0].tags, ['gc']);
});

test('search reports invalid arguments as a tool error and includes author/date', async () => {
  const handler = captureTool(registerSearch, fakeCtx(async () => ({
    topics: [{ id: 1, title: 'T', slug: 't', category_id: 0, tags: ['amex'] }],
    posts: [{ topic_id: 1, post_number: 5, blurb: 'b', username: 'alice', created_at: '2026-10-24T16:00:00Z', like_count: 3 }],
  })));
  const bad = await handler({}, {});
  assert.equal(bad.isError, true);
  assert.match(String(bad.content[0].text), /At least one of/);

  const [item] = JSON.parse(String((await handler({ query: 'amex' }, {})).content[0].text));
  assert.equal(item.author, 'alice');
  assert.equal(item.post_number, 5);
  assert.deepEqual(item.tags, ['amex']);
  assert.ok(item.posted_at);
});

test('python worker keeps one process across requests and ignores stray stdout', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nitan-worker-'));
  const script = path.join(dir, 'fake_wrapper.py');
  writeFileSync(script, [
    'import sys, json, os',
    'for line in sys.stdin:',
    '    req = json.loads(line)',
    '    print("library noise")',
    '    sys.stdout.write("@@NITAN@@" + json.dumps({"success": True, "status": 200, "body": str(os.getpid()) + " " + req["url"]}) + "\\n")',
    '    sys.stdout.flush()',
  ].join('\n'));

  const worker = new PythonBypassClient(new Logger('silent'), 'fake', script, 'python3');
  try {
    const a = await worker.request({ url: 'u1', method: 'GET', headers: {}, timeout: 5 });
    const b = await worker.request({ url: 'u2', method: 'GET', headers: {}, timeout: 5 });
    const [pidA, urlA] = String(a.body).split(' ');
    const [pidB, urlB] = String(b.body).split(' ');
    assert.equal(urlA, 'u1');
    assert.equal(urlB, 'u2');
    assert.equal(pidA, pidB);
  } finally {
    await worker.dispose();
  }
});

test('python worker reports missing dependencies when the process exits', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nitan-worker-'));
  const script = path.join(dir, 'broken_wrapper.py');
  writeFileSync(script, 'import definitely_not_installed_module\n');
  const worker = new PythonBypassClient(new Logger('silent'), 'broken', script, 'python3');
  await assert.rejects(worker.request({ url: 'u', method: 'GET', headers: {}, timeout: 5 }), /dependencies missing/);
  await worker.dispose();
});

test('HTTP transport binds to loopback and enforces --http-token', async () => {
  const indexPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.js');
  const port = 4000 + Math.floor(Math.random() * 1000);
  const token = 'test-token-0123456789abcdef';
  const proc = spawn('node', [indexPath, '--transport', 'http', '--port', String(port), '--log_level', 'silent', '--http-token', token], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    let ready = false;
    for (let i = 0; i < 20 && !ready; i++) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    assert.ok(ready, 'server should answer /health without a token');

    assert.equal((await fetch(`http://127.0.0.1:${port}/auth`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/auth?token=wrong-token-0123456789ab`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/auth?token=${token}`)).status, 200);
    const mcp = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(mcp.status, 401);
  } finally {
    proc.kill('SIGTERM');
  }
});
