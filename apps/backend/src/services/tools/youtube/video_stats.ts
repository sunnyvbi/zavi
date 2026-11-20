
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { MAX_STATS_IDS, iso8601DurationToSeconds, youtubeGet } from "./client";

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

const inputSchema = z.object({
  video_ids: z
    .array(z.string().regex(YOUTUBE_ID, "an 11-character YouTube video id"))
    .min(1)
    .max(MAX_STATS_IDS)
    .describe("Video ids, usually straight from youtube__search_videos."),
});

export type YoutubeVideoStat = {
  video_id: string;
  title: string;
  channel_title: string;
  published_at: string;
  duration_seconds: number | null;
  short_length: boolean | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
};

export type YoutubeVideoStatsResult = {
  fetched_at: string;
  items: YoutubeVideoStat[];
  missing: string[];
  provenance: "public";
  cannot_see: string[];
  note: string;
};

const SHORTS_THREE_MINUTE_CUTOFF = Date.parse("2024-10-15T00:00:00Z");
function shortsMaxSeconds(publishedAt: string): number {
  const t = Date.parse(publishedAt);
  return Number.isNaN(t) || t >= SHORTS_THREE_MINUTE_CUTOFF ? 180 : 60;
}

function num(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const youtubeVideoStatsTool: ToolSpec = {
  name: "youtube_video_stats",
  effect: "read",
  description:
    "Get the REAL public numbers for specific YouTube videos: view count, like count, comment " +
    "count, upload date and duration. Works on any public video — the company's own uploads or " +
    "the ones holding a query — with no connector. Use it to say what a video actually got " +
    "instead of guessing. Quote the numbers as returned, attributed to the named video, with " +
    "the fetch date; never average them, never compute an outlier score or ranking from them, " +
    "and never present another channel's numbers as this company's results. It CANNOT return " +
    "impressions, click-through rate, average view duration, retention, watch time, or " +
    "subscribers gained — those are private analytics and no key reaches them.",
  input_schema: inputSchema,
  async execute(_ctx, input) {
    const { video_ids } = inputSchema.parse(input ?? {});
    const unique = [...new Set(video_ids)];

    const body = await youtubeGet("videos", {
      part: "snippet,statistics,contentDetails",
      id: unique.join(","),
      maxResults: String(MAX_STATS_IDS),
    });
    const raw = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];

    const items: YoutubeVideoStat[] = raw.flatMap((it) => {
      const id = it.id;
      if (typeof id !== "string") return [];
      const sn = (it.snippet ?? {}) as Record<string, unknown>;
      const st = (it.statistics ?? {}) as Record<string, unknown>;
      const cd = (it.contentDetails ?? {}) as Record<string, unknown>;
      const secs =
        typeof cd.duration === "string" ? iso8601DurationToSeconds(cd.duration) : null;
      return [
        {
          video_id: id,
          title: typeof sn.title === "string" ? sn.title : "",
          channel_title: typeof sn.channelTitle === "string" ? sn.channelTitle : "",
          published_at: typeof sn.publishedAt === "string" ? sn.publishedAt : "",
          duration_seconds: secs,
          short_length:
            secs === null
              ? null
              : secs <= shortsMaxSeconds(typeof sn.publishedAt === "string" ? sn.publishedAt : ""),
          view_count: num(st.viewCount),
          like_count: num(st.likeCount),
          comment_count: num(st.commentCount),
        },
      ];
    });

    const returned = new Set(items.map((i) => i.video_id));
    const result: YoutubeVideoStatsResult = {
      fetched_at: new Date().toISOString(),
      items,
      missing: unique.filter((id) => !returned.has(id)),
      provenance: "public",
      cannot_see: [
        "impressions",
        "click_through_rate",
        "average_view_duration",
        "retention",
        "watch_time",
        "subscribers_gained",
      ],
      note:
        "Public counts as YouTube returned them at fetched_at. Attribute every number to its " +
        "video. Do not aggregate across channels, do not compute derived metrics, and do not " +
        "call another channel's numbers this company's results.",
    };
    return result;
  },
};
