import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../http/client.js';
import { Logger } from '../util/logger.js';
import { extractImageUrls, resolveUploadUrls } from '../util/uploads.js';
import { registerReadTopic } from '../tools/builtin/read_topic.js';
import { registerSearch } from '../tools/builtin/search.js';

const BASE = 'https://www.uscardforum.com';

function captureTool(register: Function, ctx: any) {
  let handler: Function | undefined;
  register({ registerTool(_name: string, _meta: any, h: Function) { handler = h; } }, ctx, {});
  return handler!;
}

function fakeCtx(client: Record<string, any>, extra: Record<string, unknown> = {}) {
  return {
    siteState: { ensureSelectedSite: () => ({ base: BASE, client }) },
    logger: new Logger('silent'),
    maxReadLength: 50000,
    ...extra,
  } as any;
}

test('resolveUploadUrls turns upload:// references into short-url links', () => {
  const text = '![shot|306x499](upload://sLeAx6hrb6mlZ2qnfjEGnRLQuTC.png) and [file](upload://abc)';
  assert.equal(
    resolveUploadUrls(text, `${BASE}/`),
    `![shot|306x499](${BASE}/uploads/short-url/sLeAx6hrb6mlZ2qnfjEGnRLQuTC.png) and [file](${BASE}/uploads/short-url/abc)`,
  );
});

test('extractImageUrls returns markdown image URLs once, skipping non-images', () => {
  const text = [
    `![a](${BASE}/uploads/short-url/x1.png)`,
    `![b](${BASE}/uploads/short-url/x1.png)`,
    '![c](https://asset-cdn.uscardforum.com/original/4X/c/9/9/abc.jpeg "title")',
    `[not an image](${BASE}/t/1)`,
    '![doc](https://example.com/file.pdf)',
  ].join('\n');
  assert.deepEqual(extractImageUrls(text), [
    `${BASE}/uploads/short-url/x1.png`,
    'https://asset-cdn.uscardforum.com/original/4X/c/9/9/abc.jpeg',
  ]);
});

test('read_topic order=likes returns posts by likes with full content', async () => {
  const requested: string[] = [];
  const client = {
    get: async (url: string) => {
      requested.push(url);
      if (url === '/t/9.json') return { title: 'DP 帖', slug: 'dp', posts_count: 300, highest_post_number: 300 };
      if (url.startsWith('/search.json')) {
        return { posts: [
          { id: 110, topic_id: 9, post_number: 10, username: 'b', created_at: '2026-10-24T16:00:00Z', like_count: 35, blurb: 'short' },
          { id: 101, topic_id: 9, post_number: 1, username: 'a', created_at: '2026-10-24T15:00:00Z', like_count: 196, blurb: 'short' },
          { id: 999, topic_id: 8, post_number: 3, username: 'x', like_count: 500 }, // other topic, ignored
        ] };
      }
      if (url.startsWith('/t/9/posts.json')) {
        return { post_stream: { posts: [
          { id: 101, raw: 'first post ![s](upload://abc.png)' },
          { id: 110, raw: 'tenth post' },
        ] } };
      }
      throw new Error(`unexpected ${url}`);
    },
  };
  const handler = captureTool(registerReadTopic, fakeCtx(client));
  const res = await handler({ topic_id: 9, order: 'likes', post_limit: 5 }, {});
  const text = String(res.content[0].text);

  const search = requested.find((u) => u.startsWith('/search.json'))!;
  assert.equal(new URLSearchParams(search.split('?')[1]).get('q'), 'topic:9 order:likes');
  assert.ok(requested.some((u) => u.includes('post_ids[]=110&post_ids[]=101') && u.includes('include_raw=true')));
  assert.match(text, /Sorted by likes/);
  // Order follows the search ranking, not post numbers.
  assert.ok(text.indexOf('Post #10 ') < text.indexOf('Post #1 '));
  assert.match(text, /Post #10 by @b .* · 35 likes\n  tenth post/);
  assert.match(text, new RegExp(`first post !\\[s\\]\\(${BASE}/uploads/short-url/abc.png\\)`));
  assert.doesNotMatch(text, /Post #3 /);
});

test('read_topic include_images attaches images and reports failures inline', async () => {
  const fetched: string[] = [];
  const client = {
    get: async (url: string) => {
      if (url === '/t/5.json') return { title: 'T', slug: 't', posts_count: 1, highest_post_number: 1 };
      if (url === '/raw/5?page=1') return 'a | 2026-10-24 16:00:00 UTC | #1\n\n![one](upload://one.png)\n![two](upload://two.png)\n![three](upload://three.png)';
      return '';
    },
    fetchImage: async (url: string) => {
      fetched.push(url);
      if (url.includes('two')) throw new Error('HTTP 403');
      return { data: 'aGVsbG8=', mimeType: 'image/png' };
    },
  };
  const handler = captureTool(registerReadTopic, fakeCtx(client));
  const res = await handler({ topic_id: 5, include_images: 2 }, {});

  assert.deepEqual(fetched, [`${BASE}/uploads/short-url/one.png`, `${BASE}/uploads/short-url/two.png`]);
  const images = res.content.filter((c: any) => c.type === 'image');
  assert.equal(images.length, 1);
  assert.deepEqual(images[0], { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
  assert.ok(res.content.some((c: any) => c.type === 'text' && /post #1 could not be loaded \(HTTP 403\)/.test(c.text)));
});

test('read_topic without include_images returns text only', async () => {
  const client = {
    get: async (url: string) => (url === '/t/5.json' ? { title: 'T', slug: 't' } : url === '/raw/5?page=1' ? 'a | d | #1\n\n![x](upload://x.png)' : ''),
    fetchImage: async () => { throw new Error('should not be called'); },
  };
  const res = await captureTool(registerReadTopic, fakeCtx(client))({ topic_id: 5 }, {});
  assert.equal(res.content.length, 1);
});

test('search with topic_id searches inside the topic and lists posts', async () => {
  let requested = '';
  const client = {
    get: async (url: string) => {
      requested = url;
      return {
        topics: [{ id: 541783, slug: 'topic', title: 'T' }],
        posts: [
          { topic_id: 541783, post_number: 21, username: 'u1', created_at: '2026-10-24T16:00:00Z', like_count: 2, blurb: 'trade in 54' },
          { topic_id: 541783, post_number: 76, username: 'u2', like_count: 0, blurb: 'trade in done' },
        ],
      };
    },
  };
  const handler = captureTool(registerSearch, fakeCtx(client));
  const res = await handler({ query: 'trade in', topic_id: 541783, order: 'likes' }, {});
  const q = new URLSearchParams(requested.split('?')[1]).get('q');
  assert.equal(q, 'trade in topic:541783 order:likes');
  const items = JSON.parse(String(res.content[0].text));
  assert.deepEqual(items.map((i: any) => i.post_number), [21, 76]);
  assert.equal(items[0].url, `${BASE}/t/topic/541783/21`);
  assert.equal(items[0].author, 'u1');
});

test('fetchImage only downloads from the site and its subdomains', async () => {
  const client = new HttpClient({ baseUrl: BASE, timeoutMs: 5000, logger: new Logger('silent'), auth: { type: 'none' }, bypassMethod: 'curl_cffi' });
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: any) => {
    calls.push(String(url));
    const res = new Response(Buffer.from('png-bytes'), { status: 200, headers: { 'content-type': 'image/png' } });
    Object.defineProperty(res, 'url', { value: 'https://asset-cdn.uscardforum.com/original/a.png' });
    return res;
  }) as any;
  try {
    await assert.rejects(client.fetchImage('http://127.0.0.1:8080/secret.png', 1000), /another host/);
    await assert.rejects(client.fetchImage('https://evil-uscardforum.com/a.png', 1000), /another host/);
    const img = await client.fetchImage(`${BASE}/uploads/short-url/a.png`, 1000);
    assert.equal(img.mimeType, 'image/png');
    assert.equal(Buffer.from(img.data, 'base64').toString(), 'png-bytes');
    await assert.rejects(client.fetchImage(`${BASE}/uploads/short-url/a.png`, 3), /too large/);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch as any;
    await client.dispose();
  }
});
