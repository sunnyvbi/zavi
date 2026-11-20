
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import {
  latestOwnedUsername,
  readOwnedPostsShared,
  snapshotOwnedPosts,
  OWNED_WINDOW_DAYS as WINDOW_DAYS,
  type XOwnedPost,
} from "@/services/x-social/owned-posts";

const inputSchema = z.object({
  max_results: z
    .number()
    .int()
    .min(5)
    .max(100)
    .default(20)
    .describe("How many of the operator's most recent posts to read (5-100). Each one is a metered X read; 20 is enough for a weekly review."),
  include_replies: z
    .boolean()
    .default(true)
    .describe("Include the operator's replies (default true). Replies are read in-thread, not in For You, so keep them to see the full mix."),
});

export type { XOwnedPost };

export type XReadPostMetricsResult = {
  fetched_at: string;
  handle: string | null;
  window_days: number;
  items: XOwnedPost[];
  partial_errors: string[];
  provenance: "owned";
  cannot_see: string[];
  note: string;
};

export async function snapshotLedgerMetrics(
  tenant_id: string,
  items: readonly XOwnedPost[],
  fetched_at: string,
  client?: Parameters<typeof snapshotOwnedPosts>[3],
): Promise<number> {
  return (await snapshotOwnedPosts(tenant_id, items, fetched_at, client)).ledger;
}

export const xSocialReadPostMetricsTool: ToolSpec = {
  name: "x_social_read_post_metrics",
  effect: "read",
  description:
    "Read the operator's OWN recent X posts (last 30 days) with their REAL metrics: impressions, " +
    "link clicks, profile clicks, likes, replies, reposts, quotes, bookmarks. Needs the X account " +
    "connected in Settings. Use it to say which post shapes actually earned reach — quote the numbers " +
    "as returned, attributed to the named post, with the fetch date. It CANNOT read a competitor's " +
    "numbers, anything older than 30 days, or follower history. Every call is a metered X read, so " +
    "call it once per run.",
  input_schema: inputSchema,
  async execute(ctx, rawInput) {
    const input = inputSchema.parse(rawInput);
    const tenant_id = ctx.tenant_id;
    const { fetched_at, items, partial_errors, from_snapshot } = await readOwnedPostsShared(tenant_id, {
      max_results: input.max_results,
      include_replies: input.include_replies,
    });
    const handle = await latestOwnedUsername(tenant_id);

    return {
      fetched_at,
      handle,
      window_days: WINDOW_DAYS,
      items,
      partial_errors,
      provenance: "owned",
      cannot_see: [
        "any other account's impressions or clicks",
        "posts older than 30 days (non_public/organic metrics window)",
        "follower count history",
      ],
      note: `Owned-post metrics from X, ${items.length} posts, last ${WINDOW_DAYS} days${from_snapshot ? " (today's stored read; X updates these about daily)" : ""}. Quote per post with the fetch date; never average across posts.`,
    } satisfies XReadPostMetricsResult;
  },
};
