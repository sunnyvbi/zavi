
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { sliceWhole } from "@/services/json-safe";
import { resolveInstagramReader } from "@/services/connectors/instagram-social/read";

const inputSchema = z.object({
  max_posts: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(25)
    .describe("How many of the account's most recent posts to read (1-50). 25 covers a month for most accounts."),
});

type Metrics = Record<string, number>;

export type IgOwnedPost = {
  id: string;
  permalink: string | null;
  timestamp: string;
  media_type: string;
  media_product_type: string;
  caption_head: string;
  like_count: number | null;
  comments_count: number | null;
  insights: Metrics | null;
  insights_error: string | null;
};

export type IgReadInsightsResult = {
  fetched_at: string;
  username: string | null;
  followers_count: number | null;
  media_count: number | null;
  account_28d: Metrics | null;
  account_error: string | null;
  items: IgOwnedPost[];
  provenance: "owned";
  cannot_see: string[];
  note: string;
};

const MEDIA_METRICS = "views,reach,saved,shares,likes,comments,total_interactions";
const ACCOUNT_METRICS = "reach,views,accounts_engaged,total_interactions,profile_views";

function msg(json: Record<string, unknown>): string {
  const e = json.error as { message?: string; code?: number } | undefined;
  return e?.message ? `${e.message}${e.code ? ` (code ${e.code})` : ""}` : JSON.stringify(json).slice(0, 200);
}

function parseInsights(json: Record<string, unknown>): Metrics {
  const out: Metrics = {};
  for (const row of (json.data as Array<{ name?: string; values?: Array<{ value?: unknown }>; total_value?: { value?: unknown } }> | undefined) ?? []) {
    const v = row.total_value?.value ?? row.values?.[0]?.value;
    if (row.name && typeof v === "number") out[row.name] = v;
  }
  return out;
}

export const instagramReadInsightsTool: ToolSpec = {
  name: "instagram_read_insights",
  effect: "read",
  description:
    "Read the operator's OWN Instagram account insights through their connected Instagram Business " +
    "account: the last ~25 posts with views, reach, saves, shares, likes and comments each, plus 28-day " +
    "account totals and the follower count. Needs Instagram connected in Settings. Quote numbers as " +
    "returned, per named post, with the fetch date; never average them into a rate, never compare to " +
    "a benchmark, never extend to a competitor. `impressions` no longer exists — `views` replaced it in " +
    "April 2025. One call per run.",
  input_schema: inputSchema,
  async execute(ctx, rawInput) {
    const input = inputSchema.parse(rawInput);
    const tenantId = ctx.tenant_id;

    const g = await resolveInstagramReader(tenantId);
    if (!g) {
      throw new ExpectedToolError(
        "instagram_not_connected",
        "No connected Instagram account. Ask the operator to connect Instagram in Settings; until then this channel reads public evidence only.",
        { connector_slug: "composio.instagram" },
      );
    }

    const profile = await g("me", { fields: "user_id,username,followers_count,media_count" });
    const igUserId = String(profile.json.user_id ?? profile.json.id ?? "");
    if (!profile.ok || !igUserId) {
      throw new ExpectedToolError(
        profile.status === 401 || profile.status === 403 ? "instagram_not_authorized" : "instagram_read_failed",
        `Instagram refused the read (HTTP ${profile.status}: ${msg(profile.json)}). The operator may need to reconnect Instagram in Settings.`,
      );
    }

    const since = Math.floor((Date.now() - 28 * 86_400_000) / 1000);
    const until = Math.floor(Date.now() / 1000);
    const totals = await g(`${igUserId}/insights`, {
      metric: ACCOUNT_METRICS,
      period: "day",
      metric_type: "total_value",
      since: String(since),
      until: String(until),
    });

    const media = await g(`${igUserId}/media`, {
      fields: "id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count",
      limit: String(input.max_posts),
    });
    if (!media.ok) {
      throw new ExpectedToolError("instagram_read_failed", `Instagram media list failed: HTTP ${media.status} ${msg(media.json)}`);
    }

    if (!Array.isArray(media.json.data)) {
      throw new ExpectedToolError("instagram_read_failed", "Instagram returned an invalid media list; publication status is unknown.");
    }
    const items: IgOwnedPost[] = [];
    for (const m of (media.json.data as Array<Record<string, unknown>> | undefined) ?? []) {
      const id = String(m.id ?? "");
      const ins = await g(`${id}/insights`, { metric: MEDIA_METRICS });
      items.push({
        id,
        permalink: typeof m.permalink === "string" ? m.permalink : null,
        timestamp: String(m.timestamp ?? ""),
        media_type: String(m.media_type ?? ""),
        media_product_type: String(m.media_product_type ?? ""),
        caption_head: sliceWhole(String(m.caption ?? ""), 125),
        like_count: typeof m.like_count === "number" ? m.like_count : null,
        comments_count: typeof m.comments_count === "number" ? m.comments_count : null,
        insights: ins.ok ? parseInsights(ins.json) : null,
        insights_error: ins.ok ? null : msg(ins.json),
      });
    }

    return {
      fetched_at: new Date().toISOString(),
      username: typeof profile.json.username === "string" ? profile.json.username : null,
      followers_count: typeof profile.json.followers_count === "number" ? profile.json.followers_count : null,
      media_count: typeof profile.json.media_count === "number" ? profile.json.media_count : null,
      account_28d: totals.ok ? parseInsights(totals.json) : null,
      account_error: totals.ok ? null : msg(totals.json),
      items,
      provenance: "owned",
      cannot_see: [
        "any other account's reach, views, saves or shares",
        "Stories older than 24h",
        "insights on posts older than Meta's retention window (~90 days for account metrics)",
      ],
      note: `Owned insights from Instagram for @${typeof profile.json.username === "string" ? profile.json.username : "?"}, ${items.length} posts. Quote per post with the fetch date; never average across posts.`,
    } satisfies IgReadInsightsResult;
  },
};
