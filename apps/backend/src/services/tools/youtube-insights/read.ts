
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { composioExecuteTool, type ComposioExecResult } from "@/services/connectors/composio/api";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";

const inputSchema = z.object({
  days: z.number().int().min(7).max(90).default(28).describe("Accepted for compatibility; the counters on this connection are lifetime totals."),
  max_videos: z.number().int().min(1).max(50).default(25).describe("How many of the channel's most recent videos to read (1-50)."),
});

type Row = Record<string, number | string>;

export type YtInsightsResult = {
  fetched_at: string;
  window_days: number;
  channel_title: string | null;
  handle: string | null;
  channel_totals: Row | null;
  channel_error: string | null;
  videos: Row[];
  videos_error: string | null;
  thumbnail_metrics: Row[] | null;
  thumbnail_error: string | null;
  provenance: "owned";
  cannot_see: string[];
  note: string;
};

export function iso8601ToSeconds(d: string | undefined): number | null {
  if (!d) return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d);
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  const total = (+(dd ?? 0)) * 86400 + (+(hh ?? 0)) * 3600 + (+(mm ?? 0)) * 60 + (+(ss ?? 0));
  return Number.isFinite(total) && total > 0 ? total : null;
}

function errOf(r: ComposioExecResult): string {
  return typeof r.error === "string" ? r.error : JSON.stringify(r.error ?? `HTTP ${r.status}`).slice(0, 200);
}
const UNPARSEABLE = "composio_unparseable_response";
function decoded(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return undefined; }
}
function itemsOf(r: ComposioExecResult): Array<Record<string, any>> | null {
  const d = decoded(r.data);
  if (d === undefined) return null;
  const o = (d ?? {}) as Record<string, any>;
  const inner = o.response_data === undefined ? undefined : decoded(o.response_data);
  if (o.response_data !== undefined && inner === undefined) return null;
  const items = o.items ?? (inner as Record<string, any> | null)?.items;
  return Array.isArray(items) ? items : [];
}
function put(row: Row, key: string, v: unknown): void {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  if (Number.isFinite(n)) row[key] = n;
}

export const youtubeInsightsReadTool: ToolSpec = {
  name: "youtube_insights_read",
  effect: "read",
  description:
    "Read the operator's OWN YouTube channel stats through their connected YouTube account: lifetime " +
    "channel views, subscribers and video count, and per video (most recent first, sorted by views) the " +
    "title, publish date, length, views, likes and comments. Watch time, view duration and thumbnail CTR " +
    "are not readable on this connection. Needs YouTube connected in Settings. Quote numbers as returned " +
    "per named video with the fetch date; never average across videos, never compute a score. One call per run.",
  input_schema: inputSchema,
  async execute(ctx, rawInput) {
    const input = inputSchema.parse(rawInput);
    const tenant_id = ctx.tenant_id;

    const account = await resolveOwnedComposioAccount(tenant_id, "youtube");
    if (!account) {
      throw new ExpectedToolError(
        "youtube_analytics_not_connected",
        "No connected YouTube account. Ask the operator to connect YouTube in Settings; until then this channel reads public counts only.",
        { connector_slug: "composio.youtube" },
      );
    }
    const exec = (tool_slug: string, args: Record<string, unknown>) =>
      composioExecuteTool({ tool_slug, user_id: tenant_id, connected_account_id: account.connected_account_id, arguments: args });

    const chan = await exec("YOUTUBE_GET_CHANNEL_STATISTICS", { mine: true, part: "snippet,statistics" });
    if (!chan.ok && (chan.status === 401 || chan.status === 403)) {
      throw new ExpectedToolError(
        "youtube_analytics_not_authorized",
        `YouTube refused the read (HTTP ${chan.status}: ${errOf(chan)}). Most often the connected Google account owns no YouTube channel; otherwise the operator should reconnect YouTube in Settings.`,
      );
    }
    let channel_totals: Row | null = null;
    let channel_title: string | null = null;
    let handle: string | null = null;
    const chanItems = chan.ok ? itemsOf(chan) : [];
    const channel_error = !chan.ok ? errOf(chan) : chanItems === null ? UNPARSEABLE : null;
    if (chan.ok && chanItems) {
      const st = (chanItems[0]?.statistics ?? {}) as Record<string, unknown>;
      const sn = (chanItems[0]?.snippet ?? {}) as Record<string, unknown>;
      if (typeof sn.title === "string" && sn.title.trim()) channel_title = sn.title.trim();
      if (typeof sn.customUrl === "string" && sn.customUrl.trim()) handle = sn.customUrl.trim().replace(/^@/, "");
      channel_totals = {};
      put(channel_totals, "views", st.viewCount);
      put(channel_totals, "subscriberCount", st.subscriberCount);
      put(channel_totals, "videoCount", st.videoCount);
    }

    const list = await exec("YOUTUBE_LIST_CHANNEL_VIDEOS", { mine: true, maxResults: input.max_videos });
    const listItems = list.ok ? itemsOf(list) : [];
    const ids = (listItems ?? [])
      .map((it) => String(it.contentDetails?.videoId ?? it.snippet?.resourceId?.videoId ?? it.id?.videoId ?? (typeof it.id === "string" ? it.id : "")))
      .filter(Boolean)
      .slice(0, input.max_videos);

    const videos: Row[] = [];
    let videos_error: string | null = !list.ok ? errOf(list) : listItems === null ? UNPARSEABLE : null;
    if (ids.length > 0) {
      const details = await exec("YOUTUBE_GET_VIDEO_DETAILS_BATCH", { id: ids, parts: ["snippet", "statistics", "contentDetails"] });
      const detailItems = details.ok ? itemsOf(details) : [];
      if (!details.ok) videos_error = errOf(details);
      else if (detailItems === null) videos_error = UNPARSEABLE;
      for (const it of detailItems ?? []) {
        const r: Row = { video: String(it.id ?? "") };
        if (typeof it.snippet?.title === "string") r.title = it.snippet.title;
        if (typeof it.snippet?.publishedAt === "string") r.published_at = it.snippet.publishedAt;
        const secs = iso8601ToSeconds(it.contentDetails?.duration);
        if (secs !== null) r.duration_seconds = secs;
        put(r, "views", it.statistics?.viewCount);
        put(r, "likes", it.statistics?.likeCount);
        put(r, "comments", it.statistics?.commentCount);
        videos.push(r);
      }
      videos.sort((a, b) => Number(b.views ?? 0) - Number(a.views ?? 0));
    }

    return {
      fetched_at: new Date().toISOString(),
      window_days: input.days,
      channel_title,
      handle,
      channel_totals,
      channel_error,
      videos,
      videos_error,
      thumbnail_metrics: null,
      thumbnail_error: "thumbnail impressions / CTR are not readable on this connection",
      provenance: "owned",
      cannot_see: [
        "watch time",
        "average view duration",
        "subscribers gained or lost in a window (lifetime subscriber count only)",
        "thumbnail impressions / CTR",
        "any other channel's watch time, retention or subscribers",
      ],
      note: `Owned YouTube stats (lifetime counters), ${videos.length} videos. Quote per video with the fetch date; never average across videos.`,
    } satisfies YtInsightsResult;
  },
};
