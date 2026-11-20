
import type { SupabaseClient } from "@supabase/supabase-js";
import { ExpectedToolError } from "@/services/tools/types";
import { forceRefreshConnector, getConnectorToken } from "@/services/connectors/core/token";
import { getSecret } from "@/services/secrets/vault";
import { asTenantId, tenantClient, type TenantClient } from "@/services/tenant-client";
import {
  X_SOCIAL_ACCESS_TOKEN_KEY,
  X_SOCIAL_SLUG,
  X_SOCIAL_USER_ID_KEY,
} from "@/services/connectors/x-social/constants";
import {
  consumeReadSlot,
  releaseReadSlot,
  X_METRICS_READ_CAP_CODE,
} from "@/services/x-social/read-cap";

const API = "https://api.x.com/2";
export const OWNED_WINDOW_DAYS = 30;

export type Metrics = Record<string, number>;

export function ownedPostText(text: string, entities: readonly unknown[]): string {
  const urls = new Map<string, string>();
  for (const raw of entities) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.url === "string" && typeof e.expanded_url === "string" && /^https?:\/\//i.test(e.expanded_url)) urls.set(e.url, e.expanded_url);
  }
  for (const [short, expanded] of urls) {
    const escaped = short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(escaped + "(?=$|[\\s.,!?;:)])", "g"), () => expanded);
  }
  return text;
}

export type XOwnedPost = {
  id: string;
  url: string;
  created_at: string;
  text: string;
  is_reply: boolean;
  is_repost: boolean;
  has_link: boolean;
  has_media: boolean;
  has_poll?: boolean;
  public_metrics: Metrics | null;
  non_public_metrics: Metrics | null;
  organic_metrics: Metrics | null;
  thumb_url: string | null;
  media_type: string | null;
  video_views: number | null;
};

function nums(v: unknown): Metrics | null {
  if (!v || typeof v !== "object") return null;
  const out: Metrics = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === "number" && Number.isFinite(n)) out[k] = n;
  }
  return out;
}

export function reconnectFixesRefresh(message: string): boolean {
  if (/no refresh token/i.test(message)) return true;
  if (/invalid_grant|unauthorized_client|invalid_client/i.test(message)) return true;
  return /\bHTTP 4\d\d\b/.test(message);
}

export async function fetchOwnedPosts(
  tenant_id: string,
  opts: { max_results?: number; include_replies?: boolean } = {},
): Promise<{ fetched_at: string; items: XOwnedPost[]; partial_errors: string[] }> {
  const max = Math.min(100, Math.max(5, opts.max_results ?? 20));
  const errors: string[] = [];
  const token = await getConnectorToken(tenant_id, X_SOCIAL_SLUG, X_SOCIAL_ACCESS_TOKEN_KEY).catch(
    (e: unknown) => {
      errors.push(e instanceof Error ? e.message : String(e));
      return null;
    },
  );
  const refreshError = errors[0] ?? null;
  const stored = await getSecret(tenant_id, X_SOCIAL_ACCESS_TOKEN_KEY).catch(() => null);
  const userId = await getSecret(tenant_id, X_SOCIAL_USER_ID_KEY).catch(() => null);
  if (!token && stored && refreshError) {
    if (reconnectFixesRefresh(refreshError)) {
      throw new ExpectedToolError(
        "x_not_authorized",
        `X rejected the attempt to refresh this connection: ${refreshError}. The authorization is gone, so the operator does need to reconnect X in Settings — that is a real step.`,
      );
    }
    throw new ExpectedToolError(
      "x_token_refresh_failed",
      `X is connected and its tokens are stored, but this run could not refresh the access token: ${refreshError}. This is a fault on our side or at X, not something the operator can fix — reconnecting will NOT help. Report the reason and continue on public evidence.`,
    );
  }
  if (!token || !userId) {
    throw new ExpectedToolError(
      "x_not_connected",
      "No connected X account. Ask the operator to connect X in Settings; until then this channel reads public evidence only.",
    );
  }

  const since = new Date(Date.now() - OWNED_WINDOW_DAYS * 86_400_000).toISOString();
  const u = new URL(`${API}/users/${encodeURIComponent(userId)}/tweets`);
  u.searchParams.set("max_results", String(max));
  u.searchParams.set("start_time", since);
  u.searchParams.set(
    "tweet.fields",
    "created_at,text,entities,referenced_tweets,attachments,public_metrics,non_public_metrics,organic_metrics",
  );
  u.searchParams.set("expansions", "attachments.media_keys");
  u.searchParams.set("media.fields", "media_key,type,url,preview_image_url,duration_ms,public_metrics");
  if (opts.include_replies === false) u.searchParams.set("exclude", "replies");

  const slot = await consumeReadSlot(tenant_id);
  if (!slot.ok) {
    if (slot.reason === "cap_reached") {
      throw new ExpectedToolError(
        X_METRICS_READ_CAP_CODE,
        `This account has used all ${slot.cap} of today's X metric reads. X's numbers refresh once a day anyway, so the figures already on screen are today's. The allowance resets at midnight UTC.`,
      );
    }
    throw new ExpectedToolError(
      "x_read_cap_unavailable",
      "Zavi could not check this account's daily X read allowance, so it did not spend a metered read. This is a fault on our side, not something the operator can fix.",
    );
  }

  const get = (bearer: string) =>
    fetch(u, { headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });

  const refundAndThrow = async (error: ExpectedToolError): Promise<never> => {
    await releaseReadSlot(tenant_id);
    throw error;
  };

  let resp: Response;
  try {
    resp = await get(token);
    if (resp.status === 401) {
      await forceRefreshConnector(tenant_id, X_SOCIAL_SLUG).catch(() => undefined);
      const next = await getConnectorToken(tenant_id, X_SOCIAL_SLUG, X_SOCIAL_ACCESS_TOKEN_KEY).catch(() => null);
      if (next && next !== token) resp = await get(next);
    }
  } catch (e) {
    return await refundAndThrow(
      new ExpectedToolError("x_read_failed", `X read failed before any response: ${(e as Error).message}`.slice(0, 200)),
    );
  }

  const body = (await resp.json().catch(() => ({}))) as {
    data?: Array<Record<string, unknown>>;
    includes?: { media?: Array<Record<string, unknown>> };
    errors?: Array<{ detail?: string; title?: string; message?: string }>;
    detail?: string;
    title?: string;
  };

  if (resp.status === 402) {
    return await refundAndThrow(new ExpectedToolError("x_out_of_credits", "X refused the read: Zavi's X developer app is out of API credits (HTTP 402). Tell the operator the metrics read is paused and continue on public evidence."));
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new ExpectedToolError(
      "x_not_authorized",
      `X refused the read (HTTP ${resp.status}: ${body.detail ?? body.title ?? "no detail"}). The operator may need to reconnect X in Settings.`,
    );
  }
  if (resp.status === 429) {
    return await refundAndThrow(new ExpectedToolError("x_rate_limited", "X rate limit hit for this account (HTTP 429). Retry on the next run; continue on public evidence now."));
  }
  if (!resp.ok) {
    return await refundAndThrow(new ExpectedToolError("x_read_failed", `X read failed: HTTP ${resp.status} ${body.detail ?? body.title ?? ""}`.trim()));
  }

  const mediaByKey = new Map<string, Record<string, unknown>>();
  for (const m of body.includes?.media ?? []) {
    const key = typeof m.media_key === "string" ? m.media_key : null;
    if (key) mediaByKey.set(key, m);
  }

  const items: XOwnedPost[] = (body.data ?? []).map((t) => {
    const refs = (t.referenced_tweets as Array<{ type?: string }> | undefined) ?? [];
    const urls = ((t.entities as { urls?: unknown[] } | undefined)?.urls ?? []) as unknown[];
    const media = ((t.attachments as { media_keys?: unknown[] } | undefined)?.media_keys ?? []) as unknown[];
    const polls = ((t.attachments as { poll_ids?: unknown[] } | undefined)?.poll_ids ?? []) as unknown[];
    const id = String(t.id ?? "");
    const first = media.length ? mediaByKey.get(String(media[0])) : undefined;
    const mediaMetrics = nums(first?.public_metrics);
    return {
      id,
      url: `https://x.com/i/web/status/${id}`,
      created_at: String(t.created_at ?? ""),
      text: ownedPostText(String(t.text ?? ""), urls),
      is_reply: refs.some((r) => r.type === "replied_to"),
      is_repost: refs.some((r) => r.type === "retweeted"),
      has_link: urls.length > 0,
      has_media: media.length > 0,
      has_poll: polls.length > 0,
      public_metrics: nums(t.public_metrics),
      non_public_metrics: nums(t.non_public_metrics),
      organic_metrics: nums(t.organic_metrics),
      thumb_url:
        typeof first?.url === "string"
          ? first.url
          : typeof first?.preview_image_url === "string"
            ? first.preview_image_url
            : null,
      media_type: typeof first?.type === "string" ? first.type : null,
      video_views: mediaMetrics?.view_count ?? null,
    };
  });

  return {
    fetched_at: new Date().toISOString(),
    items,
    partial_errors: (body.errors ?? []).map((e) => e.detail ?? e.message ?? e.title ?? "unknown").slice(0, 10),
  };
}

export type XOwnedProfile = {
  id: string;
  username: string | null;
  name: string | null;
  description: string | null;
  url: string | null;
  profile_image_url: string | null;
  profile_banner_url: string | null;
  pinned_post_id: string | null;
  location: string | null;
  verified: boolean | null;
  followers_count: number | null;
  following_count: number | null;
  post_count: number | null;
};

export async function fetchOwnedProfile(tenant_id: string): Promise<XOwnedProfile> {
  const token = await getConnectorToken(tenant_id, X_SOCIAL_SLUG, X_SOCIAL_ACCESS_TOKEN_KEY);
  const u = new URL(`${API}/users/me`);
  u.searchParams.set(
    "user.fields",
    "username,name,description,url,location,verified,profile_image_url,profile_banner_url,pinned_tweet_id,public_metrics",
  );
  const resp = await fetch(u, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await resp.json().catch(() => ({}))) as { data?: Record<string, unknown>; detail?: string; title?: string };
  if (!resp.ok) throw new ExpectedToolError("x_read_failed", `X profile read failed: HTTP ${resp.status} ${body.detail ?? body.title ?? ""}`.trim());
  const d = body.data ?? {};
  const pm = nums(d.public_metrics) ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.length ? v : null);
  return {
    id: String(d.id ?? ""),
    username: str(d.username),
    name: str(d.name),
    description: str(d.description),
    url: str(d.url),
    profile_image_url: str(d.profile_image_url),
    profile_banner_url: str(d.profile_banner_url),
    pinned_post_id: str(d.pinned_tweet_id),
    location: str(d.location),
    verified: typeof d.verified === "boolean" ? d.verified : null,
    followers_count: pm.followers_count ?? null,
    following_count: pm.following_count ?? null,
    post_count: pm.tweet_count ?? pm.post_count ?? null,
  };
}

export type AccountSnapshotRow = {
  captured_on: string;
  created_at?: string;
  username: string | null;
  name: string | null;
  description: string | null;
  url: string | null;
  profile_image_url: string | null;
  profile_banner_url: string | null;
  pinned_post_id: string | null;
  location: string | null;
  verified: boolean | null;
  followers_count: number | null;
  following_count: number | null;
  post_count: number | null;
};

export async function snapshotAccount(
  tenant_id: string,
  profile: XOwnedProfile,
  fetched_at: string,
  client?: TenantClient,
): Promise<boolean> {
  try {
    const sb = client ?? tenantClient(asTenantId(tenant_id));
    const { error } = await sb.from("social_account_snapshots").upsert(
      {
        tenant_id,
        channel: "x",
        captured_on: fetched_at.slice(0, 10),
        username: profile.username,
        name: profile.name,
        description: profile.description,
        url: profile.url,
        profile_image_url: profile.profile_image_url,
        profile_banner_url: profile.profile_banner_url,
        pinned_post_id: profile.pinned_post_id,
        location: profile.location,
        verified: profile.verified,
        followers_count: profile.followers_count,
        following_count: profile.following_count,
        post_count: profile.post_count,
        created_at: fetched_at,
      },
      { onConflict: "tenant_id,channel,captured_on" },
    );
    return !error;
  } catch {
    return false;
  }
}

export async function latestOwnedUsername(tenant_id: string, client?: TenantClient): Promise<string | null> {
  try {
    const sb = client ?? tenantClient(asTenantId(tenant_id));
    const { data: conn, error: connErr } = await sb
      .from("connector_metadata")
      .select("connected_at")
      .eq("slug", X_SOCIAL_SLUG)
      .limit(1);
    const connectedAt = (conn?.[0] as { connected_at?: unknown } | undefined)?.connected_at;
    if (connErr || typeof connectedAt !== "string") return null;
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const { data, error } = await sb
      .from("social_account_snapshots")
      .select("username")
      .eq("channel", "x")
      .gte("captured_on", since)
      .gte("created_at", connectedAt)
      .order("captured_on", { ascending: false })
      .limit(1);
    if (error || !Array.isArray(data)) return null;
    const u = (data[0] as { username?: unknown } | undefined)?.username;
    return typeof u === "string" && u.trim() ? u.trim().replace(/^@/, "") : null;
  } catch {
    return null;
  }
}

export async function readAccountSnapshots(
  sb: Pick<SupabaseClient, "from">,
  tenant_id: string,
  days: number,
): Promise<AccountSnapshotRow[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await sb
    .from("social_account_snapshots")
    .select("captured_on, created_at, username, name, description, url, location, verified, profile_image_url, profile_banner_url, pinned_post_id, followers_count, following_count, post_count")
    .eq("tenant_id", tenant_id)
    .eq("channel", "x")
    .gte("captured_on", since)
    .order("captured_on", { ascending: true })
    .limit(400);
  if (error) throw new Error(error.message);
  return (data ?? []) as AccountSnapshotRow[];
}

export function formatOf(
  p: Pick<XOwnedPost, "is_reply" | "is_repost" | "has_media" | "has_poll"> & { media_type?: string | null },
): string {
  if (p.is_repost) return "repost";
  if (p.is_reply) return "reply";
  if (p.has_poll) return "poll";
  if (p.media_type === "video") return "video";
  if (p.media_type === "animated_gif") return "gif";
  if (p.media_type === "photo") return "photo";
  if (p.has_media) return "media";
  return "post";
}

export function impressionsOf(m: { public?: Metrics | null; non_public?: Metrics | null; organic?: Metrics | null } | null | undefined): number {
  if (!m) return 0;
  return m.non_public?.impression_count ?? m.organic?.impression_count ?? m.public?.impression_count ?? 0;
}

export function engagementsOf(
  m: { public?: Metrics | null; non_public?: Metrics | null } | null | undefined,
): number {
  const own = m?.non_public?.engagements;
  if (typeof own === "number" && Number.isFinite(own)) return own;
  const p = m?.public;
  if (!p) return 0;
  return (p.like_count ?? 0) + (p.reply_count ?? 0) + (p.retweet_count ?? 0) + (p.quote_count ?? 0) + (p.bookmark_count ?? 0);
}

export type SnapshotRow = {
  external_post_id: string;
  captured_on: string;
  posted_at: string | null;
  text: string | null;
  url: string | null;
  format: string | null;
  has_link: boolean;
  thumb_url?: string | null;
  media_type?: string | null;
  metrics: { public?: Metrics | null; non_public?: Metrics | null; organic?: Metrics | null };
};

export async function snapshotOwnedPosts(
  tenant_id: string,
  items: readonly XOwnedPost[],
  fetched_at: string,
  client?: TenantClient,
): Promise<{ snapshots: number; ledger: number }> {
  let sb: TenantClient;
  try {
    sb = client ?? tenantClient(asTenantId(tenant_id));
  } catch {
    return { snapshots: 0, ledger: 0 };
  }
  const captured_on = fetched_at.slice(0, 10);
  const rows = items
    .filter((it) => it.id)
    .map((it) => ({
      tenant_id,
      channel: "x",
      external_post_id: it.id,
      captured_on,
      posted_at: it.created_at || null,
      text: it.text,
      url: it.url,
      format: formatOf(it),
      has_link: it.has_link,
      thumb_url: it.thumb_url,
      media_type: it.media_type,
      metrics: { public: it.public_metrics, non_public: it.non_public_metrics, organic: it.organic_metrics },
    }));
  let snapshots = 0;
  if (rows.length) {
    try {
      const { error } = await sb
        .from("social_post_metric_snapshots")
        .upsert(rows, { onConflict: "tenant_id,channel,external_post_id,captured_on" });
      if (!error) snapshots = rows.length;
    } catch {
    }
  }
  let ledger = 0;
  for (const it of items) {
    if (!it.id) continue;
    try {
      const { error } = await sb
        .from("social_posts")
        .update({
          metrics: { public: it.public_metrics, non_public: it.non_public_metrics, organic: it.organic_metrics },
          metrics_read_at: fetched_at,
        })
        .eq("channel", "x")
        .eq("external_post_id", it.id);
      if (!error) ledger += 1;
    } catch {
    }
  }
  return { snapshots, ledger };
}

export async function refreshOwnedPostsIfStale(
  tenant_id: string,
  opts: { force?: boolean; client?: TenantClient } = {},
): Promise<{ read: boolean; reason?: string; error_code?: string }> {
  let sb: TenantClient;
  try {
    sb = opts.client ?? tenantClient(asTenantId(tenant_id));
  } catch {
    return { read: false, reason: "no_client" };
  }
  const today = new Date().toISOString().slice(0, 10);
  if (!opts.force) {
    const { data, error } = await sb
      .from("social_post_metric_snapshots")
      .select("id")
      .eq("channel", "x")
      .eq("captured_on", today)
      .limit(1);
    if (error) return { read: false, reason: "throttle_unavailable", error_code: "x_snapshot_unavailable" };
    if (Array.isArray(data) && data.length > 0) return { read: false, reason: "fresh_today" };
  }
  try {
    const r = await fetchOwnedPosts(tenant_id, { max_results: 50 });
    await snapshotOwnedPosts(tenant_id, r.items, r.fetched_at, sb);
    try {
      const profile = await fetchOwnedProfile(tenant_id);
      await snapshotAccount(tenant_id, profile, r.fetched_at, sb);
    } catch {
    }
    return { read: true };
  } catch (e) {
    if (e instanceof ExpectedToolError) return { read: false, reason: e.message, error_code: e.code };
    return { read: false, reason: (e as Error).message.slice(0, 200), error_code: "x_read_failed" };
  }
}

export async function readOwnedPostsShared(
  tenant_id: string,
  opts: { max_results?: number; include_replies?: boolean; client?: TenantClient } = {},
): Promise<{ fetched_at: string; items: XOwnedPost[]; partial_errors: string[]; from_snapshot: boolean }> {
  try {
    const r = await fetchOwnedPosts(tenant_id, opts);
    await snapshotOwnedPosts(tenant_id, r.items, r.fetched_at, opts.client);
    return { ...r, from_snapshot: false };
  } catch (e) {
    if (!(e instanceof ExpectedToolError) || e.code !== X_METRICS_READ_CAP_CODE) throw e;
    const today = new Date().toISOString().slice(0, 10);
    let rows: SnapshotRow[] = [];
    try {
      const sb = opts.client ?? tenantClient(asTenantId(tenant_id));
      rows = (await readPostSnapshots(sb as unknown as Pick<SupabaseClient, "from">, tenant_id, 1)).filter((r) => r.captured_on === today);
    } catch {
      rows = [];
    }
    if (rows.length === 0) throw e;
    const items: XOwnedPost[] = rows.map((r) => ({
      id: r.external_post_id,
      url: r.url ?? `https://x.com/i/web/status/${r.external_post_id}`,
      created_at: r.posted_at ?? "",
      text: r.text ?? "",
      is_reply: r.format === "reply",
      is_repost: r.format === "repost",
      has_link: r.has_link,
      has_media: !!r.media_type || r.format === "media",
      public_metrics: r.metrics.public ?? null,
      non_public_metrics: r.metrics.non_public ?? null,
      organic_metrics: r.metrics.organic ?? null,
      thumb_url: r.thumb_url ?? null,
      media_type: r.media_type ?? null,
      video_views: null,
    }));
    const kept = opts.include_replies === false ? items.filter((i) => !i.is_reply) : items;
    return { fetched_at: `${today}T00:00:00.000Z`, items: kept.slice(0, opts.max_results ?? 100), partial_errors: [], from_snapshot: true };
  }
}

export async function readPostSnapshots(
  sb: Pick<SupabaseClient, "from">,
  tenant_id: string,
  days: number,
): Promise<SnapshotRow[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await sb
    .from("social_post_metric_snapshots")
    .select("external_post_id, captured_on, posted_at, text, url, format, has_link, thumb_url, media_type, metrics")
    .eq("tenant_id", tenant_id)
    .eq("channel", "x")
    .gte("captured_on", since)
    .order("captured_on", { ascending: false })
    .limit(5000);
  if (error) throw new Error(error.message);
  return (data ?? []) as SnapshotRow[];
}

export function dailySeries(
  rows: readonly SnapshotRow[],
  pick: (m: SnapshotRow["metrics"]) => number,
): Array<{ day: string; value: number }> {
  const byDay = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const m = byDay.get(r.captured_on) ?? new Map<string, number>();
    m.set(r.external_post_id, pick(r.metrics));
    byDay.set(r.captured_on, m);
  }
  const days = Array.from(byDay.keys()).sort();
  const out: Array<{ day: string; value: number }> = [];
  const lastSeen = new Map<string, number>();
  for (let i = 0; i < days.length; i++) {
    const today = byDay.get(days[i])!;
    let value = 0;
    for (const [id, n] of today) {
      const before = lastSeen.get(id);
      value += before === undefined ? (i > 0 ? n : 0) : Math.max(0, n - before);
      lastSeen.set(id, n);
    }
    out.push({ day: days[i], value });
  }
  return out;
}

export function dailyViewsSeries(rows: readonly SnapshotRow[]): Array<{ day: string; views: number }> {
  return dailySeries(rows, impressionsOf).map((d) => ({ day: d.day, views: d.value }));
}

export function accrualOver(
  rows: readonly SnapshotRow[],
  pick: (m: SnapshotRow["metrics"]) => number,
  from: string,
  to: string,
): number {
  return dailySeries(rows, pick)
    .filter((d) => d.day >= from && d.day <= to)
    .reduce((sum, d) => sum + d.value, 0);
}

export function latestPerPost(rows: readonly SnapshotRow[]): SnapshotRow[] {
  const seen = new Map<string, SnapshotRow>();
  for (const r of rows) {
    const cur = seen.get(r.external_post_id);
    if (!cur || r.captured_on > cur.captured_on) seen.set(r.external_post_id, r);
  }
  return Array.from(seen.values());
}
