import { z } from "zod";
import type { RegisterFn } from "../types.js";
import { getCategoryName, tagNames } from "../categories.js";
import { formatTimestamp } from "../../util/timestamp.js";

export const registerListTopTopics: RegisterFn = (server, ctx) => {
  const schema = z
    .object({
      period: z
        .enum(["daily", "weekly", "monthly", "quarterly", "yearly", "all"])
        .optional()
        .describe("Time period for top topics: daily (today), weekly (this week), monthly (this month), quarterly (this quarter), yearly (this year), all (all time). Default: daily"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Maximum number of top topics to return (default: 10, max: 50)"),
    })
    .strict();

  server.registerTool(
    "discourse_list_top_topics",
    {
      title: "List Top Topics",
      description: "Get the top topics from the forum for a specific time period (daily, weekly, monthly, quarterly, yearly, or all time). Top topics are ranked by activity, views, and engagement.",
      inputSchema: schema.shape,
    },
    async ({ period = "daily", limit = 10 }, _extra: any) => {
      try {
        const { base, client } = ctx.siteState.ensureSelectedSite();
        
        // Construct the endpoint URL based on period
        let endpoint: string;
        if (period === "daily") {
          endpoint = `/hot.json?period=daily`;
        } else {
          endpoint = `/top.json?period=${period}`;
        }
        
        // Fetch top topics from the appropriate endpoint
        const data = (await client.get(endpoint)) as any;
        
        const list = data?.topic_list ?? data;
        // Pinned topics are announcements, not top content (/hot.json includes them).
        const topics: any[] = (Array.isArray(list?.topics) ? list.topics : []).filter(
          (topic: any) => !topic.pinned && !topic.pinned_globally
        );
        
        // Limit the results
        const limitedTopics = topics.slice(0, limit);
        
        if (limitedTopics.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No top topics found for period: ${period}`,
              },
            ],
          };
        }
        
        // Build a compact JSON output for structured extraction
        const jsonOutput = limitedTopics.map((topic) => ({
          id: topic.id,
          title: topic.title || topic.fancy_title || `Topic ${topic.id}`,
          url: `${base}/t/${topic.slug || topic.id}/${topic.id}`,
          views: topic.views ?? 0,
          posts_count: topic.posts_count ?? 0,
          like_count: topic.like_count ?? 0,
          category: topic.category_id ? (topic.category_name || getCategoryName(topic.category_id)) : undefined,
          tags: tagNames(topic.tags),
          created_at: formatTimestamp(topic.created_at || ""),
        }));
        
        const text = JSON.stringify(jsonOutput, null, 2);
        
        return { content: [{ type: "text", text }] };
      } catch (e: any) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to fetch top topics: ${e?.message || String(e)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
};
