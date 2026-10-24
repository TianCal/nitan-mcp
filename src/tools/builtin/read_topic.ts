import { z } from "zod";
import type { RegisterFn } from "../types.js";
import { formatTimestamp } from "../../util/timestamp.js";
import { parseRawPage } from "../../util/raw_topic.js";
import { getCategoryName, tagNames } from "../categories.js";

interface TopicPost {
  number: number;
  username: string;
  created_at: string;
  content: string;
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

  constructor(private readonly postLimit: number, private readonly budget: number) {}

  get full(): boolean {
    return this.posts.length >= this.postLimit || this.budgetStoppedAt !== undefined;
  }

  add(post: TopicPost): void {
    if (this.full) return;
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
    username_filter: z.string().optional().describe("Filter posts by username (only show posts from this user)")
  });

  server.registerTool(
    "discourse_read_topic",
    {
      title: "Read Topic",
      description:
        "Read a topic metadata and posts. Can optionally filter to show only posts from a specific user. " +
        "Output is capped by a total character budget; when more posts remain, the result says which start_post_number to use next.",
      inputSchema: schema.shape,
    },
    async ({ topic_id, post_limit = 90, start_post_number = 1, username_filter }, _extra: any) => {
      try {
        const { base, client } = ctx.siteState.ensureSelectedSite();
        const budget = Number.isFinite(ctx.maxReadLength) ? ctx.maxReadLength : 50000;
        const collector = new PostCollector(post_limit, budget);

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

        // If username_filter is provided, use the slower but filterable endpoint
        if (username_filter) {
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
        lines.push("");
        for (const p of fetchedPosts) {
          lines.push(`- Post #${p.number} by @${p.username} (${p.created_at})`);
          lines.push(`  ${p.content}`);
        }
        lines.push("");

        const lastNumber = fetchedPosts[fetchedPosts.length - 1]?.number ?? start_post_number - 1;
        const nextStart = collector.budgetStoppedAt ?? lastNumber + 1;
        if (collector.budgetStoppedAt !== undefined) {
          lines.push(`[Output limit of ${budget} characters reached. Continue with start_post_number=${nextStart}.]`);
        } else if (fetchedPosts.length >= post_limit && highestPostNumber > lastNumber) {
          lines.push(`[More posts available. Continue with start_post_number=${nextStart}.]`);
        }
        lines.push(`Link: ${base}/t/${slug}/${topic_id}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed to read topic ${topic_id}: ${e?.message || String(e)}` }], isError: true };
      }
    }
  );
};
