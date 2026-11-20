
import { z } from "zod";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { youtubeGet } from "./client";

const inputSchema = z
  .object({
    handle: z.string().min(2).max(100).optional(),
    channel_id: z.string().max(64).optional(),
    recent_uploads: z.number().int().min(0).max(25).default(5),
  })
  .refine((v) => Boolean(v.handle) || Boolean(v.channel_id), {
    message: "pass either handle or channel_id",
  });

export type YoutubeChannelStatsResult = {
  found: boolean;
  fetched_at: string;
  channel_id: string | null;
  title: string | null;
  handle: string | null;
  description: string | null;
  published_at: string | null;
  subscriber_count: number | null;
  subscriber_count_hidden: boolean;
  video_count: number | null;
  view_count: number | null;
  uploads_playlist_id: string | null;
  recent_uploads: { video_id: string; title: string | null; published_at: string | null }[];
  recent_uploads_error: string | null;
  provenance: "public";
  cannot_see: string[];
  note: string;
};

export function channelLookupOf(
  raw: string,
): { forHandle: string } | { id: string } | { forUsername: string } {
  const t = raw.trim();
  const url = /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(.+)$/i.exec(t);
  if (url) {
    const path = url[1].split(/[?#]/)[0];
    const id = /^channel\/(UC[\w-]{10,})/i.exec(path);
    if (id) return { id: id[1] };
    const handle = /^@([^/]+)/.exec(path);
    if (handle) return { forHandle: `@${handle[1]}` };
    const legacy = /^user\/([^/]+)/i.exec(path);
    if (legacy) return { forUsername: legacy[1] };
    throw new ExpectedToolError(
      "youtube_not_a_channel_url",
      `"${t}" is not a channel link YouTube can look up. Use the channel's @handle or a youtube.com/@handle or /channel/UC... URL. This is could-not-verify, not proof the company has no channel.`,
    );
  }
  if (/^UC[\w-]{20,}$/.test(t)) return { id: t };
  return { forHandle: t.startsWith("@") ? t : `@${t}` };
}

function num(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const youtubeChannelStatsTool: ToolSpec = {
  name: "youtube_channel_stats",
  effect: "read",
  description:
    "Look up a YouTube channel by @handle or channel id and get its real public facts: title, " +
    "description, creation date, subscriber count (null when the owner hides it — hidden is " +
    "NOT zero), public video count and lifetime channel views. Use this to settle whether a " +
    "findable branded channel actually exists instead of inferring it from an empty page " +
    "fetch, and to state a real subscriber number rather than guessing. Public data, no " +
    "connector. It CANNOT see watch time, impressions, click-through rate, retention, or any " +
    "per-video private analytics. Also returns the channel's newest uploads (`recent_uploads`, " +
    "newest first, from its uploads playlist): use these, not a date-sorted search, for " +
    "\"latest videos\", then youtube__video_stats for their views.",
  input_schema: inputSchema,
  async execute(_ctx, input) {
    const args = inputSchema.parse(input ?? {});
    const params: Record<string, string> = {
      part: "snippet,statistics,contentDetails",
    };
    if (args.channel_id) params.id = args.channel_id;
    else if (args.handle) Object.assign(params, channelLookupOf(args.handle));

    const body = await youtubeGet("channels", params);
    const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
    const fetched_at = new Date().toISOString();

    const cannot_see = [
      "watch_time",
      "impressions",
      "click_through_rate",
      "retention",
      "average_view_duration",
    ];

    if (items.length === 0) {
      const result: YoutubeChannelStatsResult = {
        found: false,
        fetched_at,
        channel_id: null,
        title: null,
        handle: args.handle ?? null,
        description: null,
        published_at: null,
        subscriber_count: null,
        subscriber_count_hidden: false,
        video_count: null,
        view_count: null,
        uploads_playlist_id: null,
        recent_uploads: [],
        recent_uploads_error: null,
        provenance: "public",
        cannot_see,
        note:
          "YouTube returned no channel for this lookup. That is a real negative for THIS " +
          "handle or id — it does not prove the company has no channel under a different " +
          "name. Say which lookup you ran.",
      };
      return result;
    }

    const it = items[0]!;
    const sn = (it.snippet ?? {}) as Record<string, unknown>;
    const st = (it.statistics ?? {}) as Record<string, unknown>;
    const cd = (it.contentDetails ?? {}) as Record<string, unknown>;
    const relatedRaw = (cd.relatedPlaylists ?? {}) as Record<string, unknown>;

    const result: YoutubeChannelStatsResult = {
      found: true,
      fetched_at,
      channel_id: typeof it.id === "string" ? it.id : null,
      title: typeof sn.title === "string" ? sn.title : null,
      handle:
        typeof sn.customUrl === "string" ? sn.customUrl : (args.handle ?? null),
      description: typeof sn.description === "string" ? sn.description : null,
      published_at: typeof sn.publishedAt === "string" ? sn.publishedAt : null,
      subscriber_count: num(st.subscriberCount),
      subscriber_count_hidden: st.hiddenSubscriberCount === true,
      video_count: num(st.videoCount),
      view_count: num(st.viewCount),
      uploads_playlist_id:
        typeof relatedRaw.uploads === "string" ? relatedRaw.uploads : null,
      recent_uploads: [],
      recent_uploads_error: null,
      provenance: "public",
      cannot_see,
      note:
        "Public channel facts as YouTube returned them at fetched_at. Lifetime view_count is " +
        "the channel total, never watch time and never a per-video number.",
    };
    if (result.uploads_playlist_id && args.recent_uploads > 0) {
      try {
        const pl = await youtubeGet("playlistItems", {
          part: "snippet,contentDetails",
          playlistId: result.uploads_playlist_id,
          maxResults: String(args.recent_uploads),
        });
        const rows = Array.isArray(pl.items) ? (pl.items as Record<string, unknown>[]) : [];
        result.recent_uploads = rows
          .map((row) => {
            const s = (row.snippet ?? {}) as Record<string, unknown>;
            const c = (row.contentDetails ?? {}) as Record<string, unknown>;
            const rid = (s.resourceId ?? {}) as Record<string, unknown>;
            const video_id = typeof c.videoId === "string" ? c.videoId : typeof rid.videoId === "string" ? rid.videoId : "";
            const published_at =
              typeof c.videoPublishedAt === "string" ? c.videoPublishedAt : typeof s.publishedAt === "string" ? s.publishedAt : null;
            return { video_id, title: typeof s.title === "string" ? s.title : null, published_at };
          })
          .filter((v) => v.video_id);
      } catch (e) {
        result.recent_uploads_error = e instanceof Error ? e.message.slice(0, 200) : "uploads list unavailable";
      }
    }
    return result;
  },
};
