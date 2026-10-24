import { z } from "zod";
import type { RegisterFn } from "../types.js";
import { getCategoryByName, getCategoryName, tagNames } from "../categories.js";
import { formatTimestamp } from "../../util/timestamp.js";

export const registerSearch: RegisterFn = (server, ctx) => {
  const baseSchema = z.object({
    query: z.string().optional().describe("Search query (optional if filters are provided)"),
    max_results: z.number().int().min(1).max(50).optional().describe("Maximum number of results to return (default: 50, max: 50)"),
    order: z.enum(["relevance", "likes", "latest", "views", "latest_topic"]).optional().describe("Sort order: relevance (default), likes, latest, views, or latest_topic"),
    category: z.string().optional().describe("Category name in Chinese to search within. Examples: 玩卡, 旅行, 理财, 败家, 生活, 法律, 情感, 搬砖, 文艺, 闲聊, 白金, 吵架"),
    author: z.string().optional().describe("Filter results by author username (e.g., 'xxxyyy')"),
    after: z.string().optional().describe("Filter results after this date (format: YYYY-MM-DD, e.g., '2025-10-07')"),
    before: z.string().optional().describe("Filter results before this date (format: YYYY-MM-DD, e.g., '2025-10-08')"),
  });
  
  const schema = baseSchema.refine(
    (data) => data.query || data.category || data.author || data.after || data.before,
    {
      message: "At least one of query, category, author, after, or before must be provided",
    }
  );

  server.registerTool(
    "discourse_search",
    {
      title: "Discourse Search",
      description: "Search site content with optional sorting.",
      inputSchema: baseSchema.shape,
    },
    async (args, _extra: any) => {
      // Validate with refined schema
      const validation = schema.safeParse(args);
      if (!validation.success) {
        const message = validation.error.issues.map((issue) => issue.message).join("; ");
        return { content: [{ type: "text", text: `Invalid search arguments: ${message}` }], isError: true };
      }
      const { query = "", max_results = 50, order = "relevance", category, author, after, before } = validation.data;
      const { base, client } = ctx.siteState.ensureSelectedSite();
      const q = new URLSearchParams();
      q.set("expanded", "true");
      
      // Build the full query with order criteria and category if specified
      let fullQuery = "";
      
      // Add default search prefix if exists
      if (ctx.defaultSearchPrefix) {
        fullQuery = ctx.defaultSearchPrefix;
      }
      
      // Add query if provided
      if (query) {
        fullQuery = fullQuery ? `${fullQuery} ${query}` : query;
      }
      
      // Add author filter if provided
      if (author) {
        fullQuery = `${fullQuery} @${author}`;
      }
      
      // Add date filters if provided
      if (after) {
        fullQuery = `${fullQuery} after:${after}`;
      }
      if (before) {
        fullQuery = `${fullQuery} before:${before}`;
      }
      
      // Add category filter if provided
      if (category) {
        const categoryInfo = getCategoryByName(category);
        if (categoryInfo) {
          fullQuery = `${fullQuery} category:${categoryInfo.id}`;
        } else {
          return {
            content: [{ type: "text", text: `Category "${category}" not found. Please use a valid Chinese category name.` }],
            isError: true
          };
        }
      }
      
      // Add order criteria
      if (order !== "relevance") {
        fullQuery = `${fullQuery} order:${order}`;
      }
      q.set("q", fullQuery);
      try {
        const data = (await client.get(`/search.json?${q.toString()}`)) as any;
        const topics: any[] = data?.topics || [];
        const posts: any[] = data?.posts || [];

        // First matching post per topic (blurb, author, time)
        const topicPostMap = new Map<number, any>();
        for (const post of posts) {
          if (post.topic_id && post.blurb && !topicPostMap.has(post.topic_id)) {
            topicPostMap.set(post.topic_id, post);
          }
        }

        const jsonOutput = topics.slice(0, max_results).map((t) => {
          const post = topicPostMap.get(t.id);
          const postNumber = post ? post.post_number || 1 : undefined;
          const postNumberSuffix = postNumber ? `/${postNumber}` : "";
          const result: any = {
            topic_id: t.id,
            url: `${base}/t/${t.slug}/${t.id}${postNumberSuffix}`,
            title: t.title,
          };
          if (t.category_id) result.category = getCategoryName(t.category_id);
          const tags = tagNames(t.tags);
          if (tags.length) result.tags = tags;
          if (t.posts_count !== undefined) result.posts_count = t.posts_count;
          if (postNumber) result.post_number = postNumber;
          if (post?.username) result.author = post.username;
          if (post?.created_at) result.posted_at = formatTimestamp(post.created_at);
          if (post?.like_count !== undefined) result.like_count = post.like_count;
          if (post?.blurb) result.blurb = post.blurb;
          return result;
        });
        const text = JSON.stringify(jsonOutput, null, 2);
        return { content: [{ type: "text", text }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Search failed: ${e?.message || String(e)}` }], isError: true };
      }
    }
  );
};

