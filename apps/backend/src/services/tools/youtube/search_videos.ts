
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { MAX_SEARCH_RESULTS, chargeSearchCall, youtubeGet } from "./client";

const inputSchema = z.object({
  query: z.string().min(2).max(200).describe("The search phrase, in the searcher's own words."),
  max_results: z.number().int().min(1).max(MAX_SEARCH_RESULTS).default(5),
  duration: z.enum(["any", "short", "medium", "long"]).default("any"),
  published_after: z.string().datetime().optional(),
  order: z.enum(["relevance", "viewCount", "date"]).default("relevance"),
  channel_id: z.string().max(64).optional(),
});

export type YoutubeSearchVideosInput = z.infer<typeof inputSchema>;

export type YoutubeSearchHit = {
  video_id: string;
  title: string;
  channel_title: string;
  channel_id: string;
  published_at: string;
  description: string;
  thumbnail_url: string | null;
};

export type YoutubeSearchVideosResult = {
  query: string;
  order: string;
  duration_filter: string;
  fetched_at: string;
  items: YoutubeSearchHit[];
  provenance: "public";
  note: string;
};

export const youtubeSearchVideosTool: ToolSpec = {
  name: "youtube_search_videos",
  effect: "read",
  description:
    "Search YouTube itself for the videos that currently rank for a query, and get back each " +
    "video's id, exact title, channel and UPLOAD DATE. This is the packaging read: it shows " +
    "what a searcher actually sees on YouTube, which a general web search cannot. Filter with " +
    "`duration` ('short' = under 4 minutes, the closest public proxy for a Short — it is NOT a " +
    "Shorts-only filter), `published_after` to see whether the field is live or abandoned, and " +
    "`channel_id` to search within one channel (for its NEWEST uploads use youtube__channel_stats " +
    "`recent_uploads`; date-sorted search lags new uploads). Each result carries the thumbnail " +
    "YouTube is actually showing, so you can design a new one against the real wall. Pair the " +
    "returned ids with " +
    "youtube__video_stats for real view counts. Public data, no connector needed. It CANNOT " +
    "see impressions, click-through rate, watch time or retention for anyone. SCARCE: the " +
    "platform shares a 100-searches-per-day bucket across all customers, so a run may spend " +
    "at most 4. Choose each search deliberately.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input ?? {});
    chargeSearchCall(ctx.run_id);
    const params: Record<string, string> = {
      part: "snippet",
      type: "video",
      q: args.query,
      maxResults: String(args.max_results),
      order: args.order,
    };
    if (args.duration !== "any") params.videoDuration = args.duration;
    if (args.published_after) params.publishedAfter = args.published_after;
    if (args.channel_id) params.channelId = args.channel_id;

    const body = await youtubeGet("search", params);
    const raw = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];

    const items: YoutubeSearchHit[] = raw.flatMap((it) => {
      const id = (it.id as Record<string, unknown> | undefined)?.videoId;
      const sn = (it.snippet ?? {}) as Record<string, unknown>;
      if (typeof id !== "string") return [];
      const th = (sn.thumbnails ?? {}) as Record<string, unknown>;
      const thumb = ["maxres", "high", "medium", "default"]
        .map((k) => (th[k] as Record<string, unknown> | undefined)?.url)
        .find((u): u is string => typeof u === "string");
      return [
        {
          video_id: id,
          title: typeof sn.title === "string" ? sn.title : "",
          channel_title: typeof sn.channelTitle === "string" ? sn.channelTitle : "",
          channel_id: typeof sn.channelId === "string" ? sn.channelId : "",
          published_at: typeof sn.publishedAt === "string" ? sn.publishedAt : "",
          description: typeof sn.description === "string" ? sn.description : "",
          thumbnail_url: thumb ?? null,
        },
      ];
    });

    const result: YoutubeSearchVideosResult = {
      query: args.query,
      order: args.order,
      duration_filter: args.duration,
      fetched_at: new Date().toISOString(),
      items,
      provenance: "public",
      note:
        "Public YouTube search results, in YouTube's own order. Quote these rows as read; do " +
        "not compute a score, an average or a ranking from them.",
    };
    return result;
  },
};
