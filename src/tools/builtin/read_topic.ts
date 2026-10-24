import { z } from "zod";
import type { RegisterFn } from "../types.js";
import { formatTimestamp } from "../../util/timestamp.js";
import { parseRawPage } from "../../util/raw_topic.js";
import { getCategoryName, tagNames } from "../categories.js";
import { extractImageUrls, resolveUploadUrls } from "../../util/uploads.js";

const SEARCH_PAGE_SIZE = 50;
const MAX_LIKES_SEARCH_PAGES = 4;
const POSTS_PER_BATCH = 20;
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

interface TopicPost {
  number: number;
  username: string;
  created_at: string;
  content: string;
  likes?: number;
}

/**
 * Collects posts until either post_limit or the character budget is reached.
 * The budget covers all post content returned by one call, so a long topic cannot flood the context.
 */
class PostCollector {
  readonly posts: TopicPost[] = [];
  private used = 0;
  // Set when the budget stopped collection; the post that did not fit.
  budgetStoppedAt?: number;

  constructor(
    private readonly postLimit: number,
    private readonly budget: number,
    // Applied before measuring, so the budget counts what is actually returned.
    private readonly transform: (content: string) => string = (c) => c,
  ) {}

  get full(): boolean {
    return this.posts.length >= this.postLimit || this.budgetStoppedAt !== undefined;
  }

  add(post: TopicPost): void {
    if (this.full) return;
    post = { ...post, content: this.transform(post.content) };
    const remaining = this.budget - this.used;
    if (post.content.length > remaining) {
      if (this.posts.length > 0) {
        this.budgetStoppedAt = post.number;
        return;
      }
      // Always return at least one (truncated) post.
      post = { ...post, content: post.content.slice(0, remaining) + "\n…[truncated]" };
    }
    this.used += post.content.length;
    this.posts.push(post);
  }
}

export const registerReadTopic: RegisterFn = (server, ctx) => {
  const schema = z.object({
    topic_id: z.number().int().positive(),
    post_limit: z.number().int().min(1).max(500).optional().describe("Number of posts to fetch (default 90, max 500)"),
    start_post_number: z.number().int().min(1).optional().describe("Start from this post number (default 1, 1-based)"),
    username_filter: z.string().optional().describe("Filter posts by username (only show posts from this user)"),
    order: z
      .enum(["default", "likes"])
      .optional()
      .describe("default: posts in thread order; likes: most-liked posts first (start_post_number is ignored, at most 200 posts)"),
    include_images: z
      .number()
      .int()
      .min(0)
      .max(MAX_IMAGES)
      .optional()
      .describe(`Attach up to this many images (screenshots) from the returned posts so they can be viewed (default 0, max ${MAX_IMAGES})`),
  });

  server.registerTool(
    "discourse_read_topic",
    {
      title: "Read Topic",
      description:
        "Read a topic metadata and posts. Can optionally filter to show only posts from a specific user. " +
        "Use order=likes to read only the most-liked posts of a long thread, and include_images to see screenshots. " +
        "Output is capped by a total character budget; when more posts remain, the result says which start_post_number to use next.",
      inputSchema: schema.shape,
    },
    async ({ topic_id, post_limit = 90, start_post_number = 1, username_filter, order = "default", include_images = 0 }, _extra: any) => {
      try {
        const { base, client } = ctx.siteState.ensureSelectedSite();
        const budget = Number.isFinite(ctx.maxReadLength) ? ctx.maxReadLength : 50000;
        const collector = new PostCollector(post_limit, budget, (c) => resolveUploadUrls(c, base));

        let slug = "";
        let title = `Topic ${topic_id}`;
        let category = "";
        let tags: string[] = [];
        let highestPostNumber = 0;

        const applyMeta = (data: any) => {
          title = data?.title || title;
          category = data?.category_id ? getCategoryName(data.category_id) : "";
          tags = tagNames(data?.tags);
          slug = data?.slug || String(topic_id);
          highestPostNumber = data?.highest_post_number || data?.posts_count || 0;
        };

        if (order === "likes") {
          // In-topic search sorted by likes ranks every post in the thread; then load the raw
          // content of the winners in batches.
          applyMeta(await client.get(`/t/${topic_id}.json`));

          let terms = `topic:${topic_id} order:likes`;
          if (username_filter) terms += ` @${username_filter}`;
          const ranked: any[] = [];
          for (let page = 1; page <= MAX_LIKES_SEARCH_PAGES && ranked.length < post_limit; page++) {
            const params = new URLSearchParams({ q: terms });
            if (page > 1) params.set("page", String(page));
            const data = (await client.get(`/search.json?${params.toString()}`)) as any;
            const hits: any[] = Array.isArray(data?.posts) ? data.posts : [];
            for (const hit of hits) {
              if (hit.topic_id === topic_id && !ranked.some((r) => r.id === hit.id)) ranked.push(hit);
            }
            if (hits.length < SEARCH_PAGE_SIZE) break;
          }

          const wanted = ranked.slice(0, post_limit);
          const rawById = new Map<number, any>();
          for (let i = 0; i < wanted.length && !collector.full; i += POSTS_PER_BATCH) {
            const batch = wanted.slice(i, i + POSTS_PER_BATCH);
            const query = batch.map((p) => `post_ids[]=${p.id}`).join("&");
            const data = (await client.get(`/t/${topic_id}/posts.json?${query}&include_raw=true`)) as any;
            for (const p of data?.post_stream?.posts ?? []) rawById.set(p.id, p);
            for (const hit of batch) {
              const full = rawById.get(hit.id);
              collector.add({
                number: hit.post_number,
                username: hit.username || full?.username || "",
                created_at: formatTimestamp(hit.created_at || full?.created_at || ""),
                content: (full?.raw || full?.cooked || hit.blurb || "").toString(),
                likes: hit.like_count ?? 0,
              });
              if (collector.full) break;
            }
          }
        } else if (username_filter) {
          // The username filter needs the slower but filterable endpoint
          let current = start_post_number;
          let isFirstRequest = true;

          const buildUrl = (postNumber: number) => {
            return `/t/${topic_id}/${postNumber}.json?include_raw=true&username_filters=${encodeURIComponent(username_filter)}`;
          };

          while (!collector.full) {
            const data = (await client.get(buildUrl(current))) as any;

            if (isFirstRequest) {
              applyMeta(data);
              isFirstRequest = false;
            }

            const stream: any[] = Array.isArray(data?.post_stream?.posts) ? data.post_stream.posts : [];
            const sorted = stream.slice().sort((a, b) => (a.post_number || 0) - (b.post_number || 0));
            const fresh = sorted.filter((p) => (p.post_number || 0) >= current);
            if (fresh.length === 0) break; // No more posts / no progress

            for (const p of fresh) {
              collector.add({
                number: p.post_number,
                username: p.username,
                created_at: formatTimestamp(p.created_at || ""),
                content: (p.raw || p.cooked || p.excerpt || "").toString(),
              });
              if (collector.full) break;
            }

            current = (fresh[fresh.length - 1]?.post_number || current) + 1;
          }
        } else {
          // Use the efficient /raw/ endpoint (100 posts per page). Metadata comes from the topic JSON.
          const metaData = (await client.get(`/t/${topic_id}.json`)) as any;
          applyMeta(metaData);

          const postsPerPage = 100;
          const maxPages = 101;
          const maxWalkSteps = 10;

          // Phase 1: estimate the starting page, accounting for deleted posts.
          const postsCount = metaData?.posts_count || 0;
          const deletionRatio = postsCount > 0 && highestPostNumber > 0 ? postsCount / highestPostNumber : 1;
          const estimatedPosition = Math.max(1, Math.floor(start_post_number * deletionRatio));
          let currentPage = Math.min(maxPages, Math.max(1, Math.floor((estimatedPosition - 1) / postsPerPage) + 1));

          const fetchPage = async (page: number) => parseRawPage(String((await client.get(`/raw/${topic_id}?page=${page}`)) ?? ""));

          // Phase 2: walk to the page that contains start_post_number.
          let pagePosts = await fetchPage(currentPage);
          for (let step = 0; step < maxWalkSteps && pagePosts.length > 0; step++) {
            const numbers = pagePosts.map((p) => p.number);
            if (Math.min(...numbers) > start_post_number && currentPage > 1) {
              currentPage--;
            } else if (Math.max(...numbers) < start_post_number && currentPage < maxPages) {
              currentPage++;
            } else {
              break;
            }
            pagePosts = await fetchPage(currentPage);
          }
          if (pagePosts.length === 0 && currentPage > 1) {
            // Overshot past the end (e.g. estimate too high); step back once.
            currentPage--;
            pagePosts = await fetchPage(currentPage);
          }

          // Phase 3: read forward. Stop when a page brings nothing new, so an out-of-range
          // page that repeats the last one cannot produce duplicates or loop forever.
          const seen = new Set<number>();
          for (let pages = 0; pages <= maxPages && !collector.full; pages++) {
            let progressed = false;
            for (const p of pagePosts) {
              if (seen.has(p.number)) continue;
              seen.add(p.number);
              progressed = true;
              if (p.number < start_post_number) continue;
              collector.add({
                number: p.number,
                username: p.username,
                created_at: formatTimestamp(p.timestamp),
                content: p.content,
              });
              if (collector.full) break;
            }
            if (!progressed || collector.full) break;
            currentPage++;
            pagePosts = await fetchPage(currentPage);
          }
        }

        const fetchedPosts = collector.posts;
        const lines: string[] = [];
        lines.push(`# ${title}`);
        if (category) lines.push(`Category: ${category}`);
        if (tags.length) lines.push(`Tags: ${tags.join(", ")}`);
        if (username_filter) lines.push(`Filtered by user: @${username_filter}`);
        if (order === "likes") lines.push("Sorted by likes (most-liked first)");
        lines.push("");
        for (const p of fetchedPosts) {
          const likes = p.likes !== undefined ? ` · ${p.likes} likes` : "";
          lines.push(`- Post #${p.number} by @${p.username} (${p.created_at})${likes}`);
          lines.push(`  ${p.content}`);
        }
        lines.push("");

        const lastNumber = fetchedPosts[fetchedPosts.length - 1]?.number ?? start_post_number - 1;
        const nextStart = collector.budgetStoppedAt ?? lastNumber + 1;
        if (order === "likes") {
          if (collector.budgetStoppedAt !== undefined) {
            lines.push(`[Output limit of ${budget} characters reached after ${fetchedPosts.length} posts. Use a smaller post_limit or read single posts with order=default.]`);
          }
        } else if (collector.budgetStoppedAt !== undefined) {
          lines.push(`[Output limit of ${budget} characters reached. Continue with start_post_number=${nextStart}.]`);
        } else if (fetchedPosts.length >= post_limit && highestPostNumber > lastNumber) {
          lines.push(`[More posts available. Continue with start_post_number=${nextStart}.]`);
        }
        lines.push(`Link: ${base}/t/${slug}/${topic_id}`);

        const content: any[] = [{ type: "text", text: lines.join("\n") }];
        if (include_images > 0) {
          content.push(...(await loadImages(client, fetchedPosts, include_images, ctx.logger)));
        }
        return { content };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed to read topic ${topic_id}: ${e?.message || String(e)}` }], isError: true };
      }
    }
  );
};

// Fetch the first `limit` images referenced by the posts. Each image is preceded by a text block
// saying which post it belongs to; failures are reported inline instead of failing the call.
async function loadImages(client: any, posts: TopicPost[], limit: number, logger: { debug(msg: string): void }) {
  const refs: Array<{ post: number; url: string }> = [];
  for (const p of posts) {
    for (const url of extractImageUrls(p.content)) {
      if (refs.length >= limit) break;
      if (!refs.some((r) => r.url === url)) refs.push({ post: p.number, url });
    }
    if (refs.length >= limit) break;
  }

  const blocks: any[] = [];
  for (const ref of refs) {
    try {
      const image = await client.fetchImage(ref.url, MAX_IMAGE_BYTES);
      blocks.push({ type: "text", text: `Image from post #${ref.post}: ${ref.url}` });
      blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
    } catch (e: any) {
      logger.debug(`Skipping image ${ref.url}: ${e?.message || String(e)}`);
      blocks.push({ type: "text", text: `Image from post #${ref.post} could not be loaded (${e?.message || String(e)}): ${ref.url}` });
    }
  }
  return blocks;
}
