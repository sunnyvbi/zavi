
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { composioProxy } from "@/services/connectors/composio/api";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { INSTAGRAM_GRAPH_URL, INSTAGRAM_GRAPH_VERSION } from "@/services/connectors/instagram-social/constants";

export const INSTAGRAM_CHANNEL = "instagram";
export const INSTAGRAM_METER_KEY = "instagram_metrics";
export const INSTAGRAM_READS_PER_DAY = 3;
const MAX_POSTS = 25;

const MEDIA_METRICS = "views,reach,saved,shares,likes,comments,total_interactions";

type Metrics = Record<string, number>;

function parseInsights(json: Record<string, unknown>): Metrics {
  const out: Metrics = {};
  for (const row of (json.data as Array<{ name?: string; total_value?: { value?: unknown }; values?: Array<{ value?: unknown }> }> | undefined) ?? []) {
    const v = row.total_value?.value ?? row.values?.[0]?.value;
    if (row.name && typeof v === "number") out[row.name] = v;
  }
  return out;
}

function errMsg(json: Record<string, unknown>): string {
  const e = json.error as { message?: string } | undefined;
  return e?.message ?? JSON.stringify(json).slice(0, 200);
}

export type RefreshResult =
  | { ok: true; posts: number; used: number; cap: number }
  | { ok: false; reason: "not_connected" | "cap_reached" | "unavailable" | "read_failed"; message: string };

export async function refreshInstagram(tenantId: string): Promise<RefreshResult> {
  const capturedAt = new Date().toISOString();
  let account;
  try {
    account = await resolveOwnedComposioAccount(tenantId, "instagram");
  } catch {
    return { ok: false, reason: "unavailable", message: "Zavi could not check the Instagram connection just now." };
  }
  if (!account) return { ok: false, reason: "not_connected", message: "Connect Instagram in Settings first." };

  let used = 0;
  try {
    const { data, error } = await tenantRpc(asTenantId(tenantId), "consume_metered_read_or_reject", {
      p_day: capturedAt.slice(0, 10),
      p_key: INSTAGRAM_METER_KEY,
      p_cap: INSTAGRAM_READS_PER_DAY,
    });
    if (error) return { ok: false, reason: "unavailable", message: "Zavi could not check today's refresh allowance." };
    if (data === null || data === undefined) {
      return { ok: false, reason: "cap_reached", message: `All ${INSTAGRAM_READS_PER_DAY} of today's Instagram refreshes are used. They reset at midnight UTC.` };
    }
    used = Number(data);
  } catch {
    return { ok: false, reason: "unavailable", message: "Zavi could not check today's refresh allowance." };
  }

  const g = (path: string, params: Record<string, string>) => {
    const u = new URL(`${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_GRAPH_VERSION}/${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return composioProxy({ account, method: "GET", endpoint: u.toString() });
  };

  let igUserId: string;
  let profile: Awaited<ReturnType<typeof g>>;
  let media: Awaited<ReturnType<typeof g>>;
  try {
    profile = await g("me", { fields: "user_id,username,name,profile_picture_url,followers_count,media_count" });
    igUserId = String(profile.json.user_id ?? profile.json.id ?? "");
    if (!profile.ok || !igUserId) {
      return { ok: false, reason: "read_failed", message: `Instagram refused the read (HTTP ${profile.status}: ${errMsg(profile.json)}). Reconnecting Instagram in Settings usually fixes this.` };
    }
    media = await g(`${igUserId}/media`, {
      fields: "id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count",
      limit: String(MAX_POSTS),
    });
    if (!media.ok) {
      return { ok: false, reason: "read_failed", message: `Instagram media list failed: HTTP ${media.status} ${errMsg(media.json)}` };
    }
    if (!Array.isArray(media.json.data) || media.json.data.some((m) =>
      !m || typeof m !== "object" || !["string", "number"].includes(typeof m.id) || !String(m.id).trim(),
    )) {
      return { ok: false, reason: "read_failed", message: "Instagram returned an unreadable media list. Your stored numbers have been kept." };
    }
  } catch (err) {
    return { ok: false, reason: "read_failed", message: (err as Error)?.message || "Instagram did not answer." };
  }

  const posts: Array<Record<string, unknown>> = [];
  for (const m of (media.json.data as Array<Record<string, unknown>> | undefined) ?? []) {
    const id = String(m.id ?? "");
    let insights: Metrics = {};
    try {
      const ins = await g(`${id}/insights`, { metric: MEDIA_METRICS });
      if (ins.ok) insights = parseInsights(ins.json);
    } catch {
    }
    posts.push({
      external_post_id: id,
      posted_at: typeof m.timestamp === "string" ? m.timestamp : null,
      text: String(m.caption ?? "").slice(0, 4000),
      url: typeof m.permalink === "string" ? m.permalink : null,
      format: typeof m.media_product_type === "string" ? m.media_product_type : null,
      has_link: /https?:\/\//.test(String(m.caption ?? "")),
      metrics: {
        ...insights,
        likes: insights.likes ?? (typeof m.like_count === "number" ? m.like_count : null),
        comments: insights.comments ?? (typeof m.comments_count === "number" ? m.comments_count : null),
      },
    });
  }

  try {
    const stored = await tenantRpc(asTenantId(tenantId), "store_instagram_snapshots", {
      p_connection_id: account.connected_account_id,
      p_account_id: igUserId,
      p_captured_at: capturedAt,
      p_account: {
        username: typeof profile.json.username === "string" ? profile.json.username : null,
        name: typeof profile.json.name === "string" ? profile.json.name : null,
        profile_image_url: typeof profile.json.profile_picture_url === "string" ? profile.json.profile_picture_url : null,
        followers_count: typeof profile.json.followers_count === "number" ? profile.json.followers_count : null,
        post_count: typeof profile.json.media_count === "number" ? profile.json.media_count : null,
      },
      p_posts: posts,
    });
    if (stored.error) throw new Error(stored.error.message);
    if (stored.data !== true) {
      return { ok: false, reason: "unavailable", message: "The Instagram connection changed or a newer refresh finished during this read. Reload to see the latest account." };
    }
  } catch (err) {
    return { ok: false, reason: "unavailable", message: `Read Instagram, but could not store it: ${(err as Error)?.message ?? err}` };
  }

  return { ok: true, posts: posts.length, used, cap: INSTAGRAM_READS_PER_DAY };
}
