
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { utcDay } from "@/services/x-social/read-cap";
import {
  isTikTokConnected,
  queryAccountStats,
  queryVideoList,
} from "@/services/connectors/tiktok/api";

export const TIKTOK_CHANNEL = "tiktok";
export const TIKTOK_METER_KEY = "tiktok_metrics";
export const TIKTOK_READS_PER_DAY = 24;
const MAX_VIDEOS = 20;

export type RefreshResult =
  | { ok: true; posts: number; used: number; cap: number }
  | { ok: false; reason: "not_connected" | "cap_reached" | "unavailable" | "read_failed"; message: string };

export async function refreshTikTok(tenantId: string): Promise<RefreshResult> {
  let connected = false;
  try {
    connected = await isTikTokConnected(tenantId);
  } catch {
    return { ok: false, reason: "unavailable", message: "Zavi could not check the TikTok connection just now." };
  }
  if (!connected) return { ok: false, reason: "not_connected", message: "Connect TikTok in Settings first." };

  let used = 0;
  try {
    const { data, error } = await tenantRpc(asTenantId(tenantId), "consume_metered_read_or_reject", {
      p_day: utcDay(),
      p_key: TIKTOK_METER_KEY,
      p_cap: TIKTOK_READS_PER_DAY,
    });
    if (error) return { ok: false, reason: "unavailable", message: "Zavi could not check today's refresh allowance." };
    if (data === null || data === undefined) {
      return { ok: false, reason: "cap_reached", message: `All ${TIKTOK_READS_PER_DAY} of today's TikTok refreshes are used. They reset at midnight UTC.` };
    }
    used = Number(data);
  } catch {
    return { ok: false, reason: "unavailable", message: "Zavi could not check today's refresh allowance." };
  }

  let stats: Awaited<ReturnType<typeof queryAccountStats>>;
  let videos: Array<Record<string, unknown>>;
  try {
    stats = await queryAccountStats(tenantId);
    const list = await queryVideoList(tenantId, MAX_VIDEOS);
    if (!Array.isArray(list?.data?.videos) || list.data.videos.some((video: unknown) => {
      if (!video || typeof video !== "object") return true;
      const id = (video as { id?: unknown }).id;
      return !["string", "number"].includes(typeof id) || !String(id).trim();
    })) {
      return { ok: false, reason: "read_failed", message: "TikTok returned an invalid video list." };
    }
    videos = list.data.videos;
  } catch (err) {
    return { ok: false, reason: "read_failed", message: (err as Error)?.message || "TikTok did not answer." };
  }

  const n = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const posts = videos
    .filter((v) => v.id != null)
    .map((v) => {
      const text = String(v.title ?? v.video_description ?? "").slice(0, 4000);
      return {
        tenant_id: tenantId,
        channel: TIKTOK_CHANNEL,
        external_post_id: String(v.id),
        captured_on: utcDay(),
        posted_at: typeof v.create_time === "number" ? new Date(v.create_time * 1000).toISOString() : null,
        text,
        url: typeof v.share_url === "string" ? v.share_url : null,
        format: "VIDEO",
        has_link: /https?:\/\//.test(text),
        metrics: {
          views: n(v.view_count),
          likes: n(v.like_count),
          comments: n(v.comment_count),
          shares: n(v.share_count),
        },
      };
    });

  try {
    const sb = tenantClient(asTenantId(tenantId));
    if (posts.length) {
      const rows = await sb
        .from("social_post_metric_snapshots")
        .upsert(posts, { onConflict: "tenant_id,channel,external_post_id,captured_on" });
      if (rows.error) throw new Error(rows.error.message);
    }
    const acct = await sb.from("social_account_snapshots").upsert(
      {
        tenant_id: tenantId,
        channel: TIKTOK_CHANNEL,
        captured_on: utcDay(),
        username: null,
        name: stats.display_name,
        profile_image_url: stats.avatar_url,
        followers_count: stats.follower_count,
        post_count: stats.video_count,
      },
      { onConflict: "tenant_id,channel,captured_on" },
    );
    if (acct.error) throw new Error(acct.error.message);
  } catch (err) {
    return { ok: false, reason: "unavailable", message: `Read TikTok, but could not store it: ${(err as Error)?.message ?? err}` };
  }

  return { ok: true, posts: posts.length, used, cap: TIKTOK_READS_PER_DAY };
}
