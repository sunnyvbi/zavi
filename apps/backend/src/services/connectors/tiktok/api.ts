import { getSecret } from "@/services/secrets/vault";
import { asTenantId, tenantClient, tenantRpc, tenantStorage } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { assertNoLabRefresh } from "@/services/connectors/core/lab-mode";

const API = "https://open.tiktokapis.com";
const CONNECT_PATH = "/workspace?tab=settings";

type TokenBundle = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in?: number;
  open_id: string;
  scope: string;
};

export function tiktokConfig() {
  const client_key = process.env.TIKTOK_CLIENT_KEY;
  const client_secret = process.env.TIKTOK_CLIENT_SECRET;
  const base = process.env.BACKEND_PUBLIC_URL;
  if (!client_key || !client_secret || !base) {
    throw new Error("tiktok_misconfigured: set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, and BACKEND_PUBLIC_URL");
  }
  return {
    client_key,
    client_secret,
    redirect_uri: `${base.replace(/\/$/, "")}/api/connectors/tiktok/callback`,
  };
}

export function tiktokAuthorizeUrl(state: string): string {
  const c = tiktokConfig();
  const q = new URLSearchParams({
    client_key: c.client_key,
    response_type: "code",
    scope: "user.info.basic,user.info.stats,video.list,video.upload,video.publish",
    redirect_uri: c.redirect_uri,
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenBundle> {
  const r = await fetch(`${API}/v2/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await r.text();
  let parsed: (Partial<TokenBundle> & { error?: string; error_description?: string }) | null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!r.ok || !parsed || parsed.error || !parsed.access_token || !parsed.refresh_token || !parsed.open_id) {
    const reason = parsed?.error
      ? `${parsed.error}${parsed.error_description ? `: ${parsed.error_description}` : ""}`
      : raw.slice(0, 300);
    throw new Error(`TikTok token exchange failed (${r.status}): ${reason}`);
  }
  return {
    ...parsed,
    scope: parsed.scope ?? "",
    expires_in: Number(parsed.expires_in) || 86_400,
  } as TokenBundle;
}

export async function revokeTikTokToken(token: string): Promise<void> {
  const c = tiktokConfig();
  const r = await fetch(`${API}/v2/oauth/revoke/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: c.client_key, client_secret: c.client_secret, token }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`TikTok revoke failed (${r.status})`);
}

export async function exchangeTikTokCode(code: string): Promise<TokenBundle> {
  const c = tiktokConfig();
  return tokenRequest({
    client_key: c.client_key,
    client_secret: c.client_secret,
    code,
    grant_type: "authorization_code",
    redirect_uri: c.redirect_uri,
  });
}

async function refreshTikTokToken(refresh_token: string): Promise<TokenBundle> {
  assertNoLabRefresh("tiktok");
  const c = tiktokConfig();
  return tokenRequest({
    client_key: c.client_key,
    client_secret: c.client_secret,
    grant_type: "refresh_token",
    refresh_token,
  });
}

export async function tiktokAccessToken(tenant_id: string): Promise<string> {
  const [access, refresh] = await Promise.all([
    getSecret(tenant_id, "tiktok.access_token"),
    getSecret(tenant_id, "tiktok.refresh_token"),
  ]);
  if (!access || !refresh) {
    throw new ExpectedToolError("tiktok_not_connected", `Connect TikTok at ${CONNECT_PATH} before using TikTok tools.`);
  }
  const tid = asTenantId(tenant_id);
  const { data } = await tenantClient(tid)
    .from("connector_metadata")
    .select("token_expires_at")
    .eq("slug", "tiktok")
    .maybeSingle();
  const expires = (data as { token_expires_at?: string | null } | null)?.token_expires_at;
  if (!expires || new Date(expires).getTime() > Date.now() + 5 * 60_000) return access;

  const next = await refreshTikTokToken(refresh);
  const { error } = await tenantRpc(tid, "refresh_tiktok_connection", {
    p_access_token: next.access_token,
    p_refresh_token: next.refresh_token,
    p_expires_at: new Date(Date.now() + next.expires_in * 1000).toISOString(),
  });
  if (error) throw new Error(`refresh_tiktok_connection failed: ${error.message}`);
  return next.access_token;
}

function quotePostIds(raw: string): string {
  return raw.replace(
    /("publicl?a?l?y_available_post_id"\s*:\s*\[)([^\]]*)\]/g,
    (_m, head: string, ids: string) => `${head}${ids.replace(/(^|[\s,])(\d+)(?=\s*(,|$))/g, '$1"$2"')}]`,
  );
}

async function tiktokRequest<T>(
  tenant_id: string,
  path: string,
  init: { method: "GET" } | { method: "POST"; body: unknown },
): Promise<T> {
  const token = await tiktokAccessToken(tenant_id);
  let r: Response;
  try {
    r = await fetch(`${API}${path}`, init.method === "GET"
      ? { method: "GET", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) }
      : {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify(init.body),
        signal: AbortSignal.timeout(20_000),
      });
  } catch (e) {
    throw new ExpectedToolError("tiktok_timeout", `TikTok did not respond: ${(e as Error).message}`);
  }
  const raw = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(quotePostIds(raw)); } catch { parsed = null; }
  const code = parsed?.error?.code;
  if (code === "scope_not_authorized") {
    throw new ExpectedToolError(
      "tiktok_scope_missing",
      `This TikTok connection was authorized before the permission this needs existed. Disconnect and reconnect TikTok at ${CONNECT_PATH}.`,
      { status: r.status, vendor_code: code },
    );
  }
  if (!r.ok || (code && code !== "ok")) {
    throw new ExpectedToolError(
      code === "access_token_invalid" ? "tiktok_token_expired" : "tiktok_api_failed",
      `TikTok API failed (${r.status}): ${parsed?.error?.message || code || raw.slice(0, 300)}`,
      { status: r.status, vendor_code: code },
    );
  }
  return parsed as T;
}

export async function tiktokApi<T>(tenant_id: string, path: string, body: unknown): Promise<T> {
  return tiktokRequest<T>(tenant_id, path, { method: "POST", body });
}

export async function queryAccountStats(tenant_id: string) {
  const res = await tiktokRequest<any>(
    tenant_id,
    "/v2/user/info/?fields=display_name,avatar_url,follower_count,likes_count,video_count",
    { method: "GET" },
  );
  const user = res?.data?.user;
  if (!user) throw new ExpectedToolError("tiktok_api_failed", "TikTok returned no user object.");
  const count = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    display_name: typeof user.display_name === "string" ? user.display_name : null,
    avatar_url: typeof user.avatar_url === "string" ? user.avatar_url : null,
    follower_count: count(user.follower_count),
    likes_count: count(user.likes_count),
    video_count: count(user.video_count),
    fetched_at: new Date().toISOString(),
  };
}

export const TIKTOK_VIDEO_LIST_FIELDS =
  "id,title,video_description,duration,create_time,cover_image_url,share_url,embed_link,view_count,like_count,comment_count,share_count";

export async function queryVideoList(tenant_id: string, max_count = 20) {
  return tiktokApi<any>(tenant_id, `/v2/video/list/?fields=${TIKTOK_VIDEO_LIST_FIELDS}`, { max_count });
}

export async function queryCreatorInfo(tenant_id: string) {
  return tiktokApi<any>(tenant_id, "/v2/post/publish/creator_info/query/", {});
}

export async function initTikTokPost(
  tenant_id: string,
  mediaType: "VIDEO" | "PHOTO",
  payload: Record<string, unknown>,
) {
  const path = mediaType === "VIDEO"
    ? "/v2/post/publish/video/init/"
    : "/v2/post/publish/content/init/";
  return tiktokApi<any>(tenant_id, path, payload);
}

export async function initTikTokDraft(
  tenant_id: string,
  mediaType: "VIDEO" | "PHOTO",
  payload: Record<string, unknown>,
) {
  const path = mediaType === "VIDEO"
    ? "/v2/post/publish/inbox/video/init/"
    : "/v2/post/publish/content/init/";
  return tiktokApi<any>(tenant_id, path, payload);
}

export async function fetchTikTokPostStatus(tenant_id: string, publish_id: string) {
  return tiktokApi<any>(tenant_id, "/v2/post/publish/status/fetch/", { publish_id });
}

const VIDEO_BUCKET = "launch-video-media";
const MEDIA_URL_TTL_SECONDS = 300;
const TIKTOK_MAX_CHUNK_BYTES = 64 * 1024 * 1024;

export const TIKTOK_VIDEO_PATH_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp4$/;

export async function readTikTokVideoBytes(tenant_id: string, video_path: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(video_path)) {
    throw new ExpectedToolError(
      "tiktok_video_path_required",
      "video_path must be a storage path, not a URL. Upload the video through chat first; TikTok media is pushed from our own storage, never fetched from a third-party host.",
    );
  }
  if (!TIKTOK_VIDEO_PATH_RE.test(video_path)) {
    throw new ExpectedToolError("tiktok_video_path_invalid", "video_path must look like <tenant-id>/<uuid>.mp4.");
  }
  if (!video_path.startsWith(`${tenant_id}/`)) {
    throw new ExpectedToolError("tiktok_video_path_foreign", "video_path is not owned by this workspace.");
  }
  const { data, error } = await tenantStorage(asTenantId(tenant_id))
    .from(VIDEO_BUCKET)
    .createSignedUrl(video_path, MEDIA_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new ExpectedToolError("tiktok_video_unreadable", `Could not read the video: ${error?.message ?? "no signed url"}`);
  }
  const r = await fetch(data.signedUrl, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) {
    throw new ExpectedToolError("tiktok_video_unreadable", `Could not download the video (${r.status}).`);
  }
  return Buffer.from(await r.arrayBuffer());
}

export async function sendTikTokVideoToInbox(tenant_id: string, video_path: string): Promise<{ publish_id: string }> {
  const bytes = await readTikTokVideoBytes(tenant_id, video_path);
  return publishTikTokVideoBytes(tenant_id, "/v2/post/publish/inbox/video/init/", null, bytes);
}

export async function publishTikTokVideoBytes(
  tenant_id: string,
  path: "/v2/post/publish/video/init/" | "/v2/post/publish/inbox/video/init/",
  post_info: Record<string, unknown> | null,
  bytes: Buffer,
): Promise<{ publish_id: string }> {
  const video_size = bytes.byteLength;
  if (video_size === 0) {
    throw new ExpectedToolError("tiktok_video_empty", "The video file is empty.");
  }
  if (video_size > TIKTOK_MAX_CHUNK_BYTES) {
    throw new ExpectedToolError(
      "tiktok_video_too_large",
      `Video is ${Math.round(video_size / 1024 / 1024)}MB; TikTok accepts at most 64MB in one chunk. Multi-chunk upload is not implemented — see publishTikTokVideoBytes.`,
    );
  }

  const init = await tiktokApi<any>(tenant_id, path, {
    ...(post_info ? { post_info } : {}),
    source_info: {
      source: "FILE_UPLOAD",
      video_size,
      chunk_size: video_size,
      total_chunk_count: 1,
    },
  });
  const publish_id = init?.data?.publish_id;
  const upload_url = init?.data?.upload_url;
  if (!publish_id || !upload_url) {
    throw new ExpectedToolError("tiktok_upload_init_failed", "TikTok did not return an upload URL.");
  }

  let put: Response;
  try {
    put = await fetch(upload_url, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(video_size),
        "Content-Range": `bytes 0-${video_size - 1}/${video_size}`,
      },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(10 * 60_000),
    });
  } catch (e) {
    throw new ExpectedToolError("tiktok_upload_timeout", `TikTok byte upload did not complete: ${(e as Error).message}`);
  }
  if (!put.ok) {
    const body = await put.text().catch(() => "");
    throw new ExpectedToolError("tiktok_upload_failed", `TikTok byte upload failed (${put.status}): ${body.slice(0, 300)}`, { status: put.status });
  }
  return { publish_id };
}

export async function isTikTokConnected(tenantId: string): Promise<boolean> {
  const token = await getSecret(tenantId, "tiktok.access_token").catch(() => null);
  return Boolean(token);
}

export async function isTikTokPublishUsable(tenantId: string): Promise<boolean> {
  try {
    tiktokConfig();
  } catch {
    return false;
  }
  const [access, refresh] = await Promise.all([
    getSecret(tenantId, "tiktok.access_token").catch(() => null),
    getSecret(tenantId, "tiktok.refresh_token").catch(() => null),
  ]);
  return Boolean(access && refresh);
}

export const TIKTOK_PRIVATE_ONLY = "unaudited_client_can_only_post_to_private_accounts";
export const TIKTOK_PRIVATE_ONLY_MESSAGE =
  "Set your TikTok account to private until Zavi's TikTok review clears, then post again";

type TikTokPublishResult = { ok: boolean; status: number; raw: Record<string, unknown> };

function tiktokFailure(e: unknown): TikTokPublishResult {
  const err = e as { code?: string; message?: string; meta?: { status?: number; vendor_code?: string } };
  if (err?.meta?.vendor_code === TIKTOK_PRIVATE_ONLY) {
    return { ok: false, status: 400, raw: { code: TIKTOK_PRIVATE_ONLY, error: TIKTOK_PRIVATE_ONLY, message: TIKTOK_PRIVATE_ONLY_MESSAGE } };
  }
  const raw = { error: err?.code ?? "tiktok_publish_failed", message: err?.message };
  if (e instanceof ExpectedToolError) {
    if (e.code === "tiktok_timeout" || e.code === "tiktok_upload_timeout") return { ok: false, status: 502, raw };
    const vendor = typeof e.meta?.status === "number" ? e.meta.status : 0;
    if ((e.code === "tiktok_api_failed" || e.code === "tiktok_upload_failed") && (vendor >= 500 || vendor === 429)) {
      return { ok: false, status: 502, raw };
    }
    return { ok: false, status: 400, raw };
  }
  const message = typeof err?.message === "string" ? err.message : "";
  if (message.startsWith("tiktok_misconfigured")) return { ok: false, status: 400, raw: { ...raw, error: "tiktok_misconfigured" } };
  const exchange = message.match(/^TikTok token exchange failed \((\d+)\)/);
  if (exchange && Number(exchange[1]) < 500 && Number(exchange[1]) !== 429) {
    return { ok: false, status: 400, raw: { ...raw, error: "tiktok_token_expired" } };
  }
  return { ok: false, status: 502, raw };
}

const PUBLISH_POLL_ATTEMPTS = 60;
const PUBLISH_POLL_DELAY_MS = 5_000;

export type TikTokPrivacy =
  | "PUBLIC_TO_EVERYONE"
  | "MUTUAL_FOLLOW_FRIENDS"
  | "FOLLOWER_OF_CREATOR"
  | "SELF_ONLY";

export const TIKTOK_PRIVACY_VALUES = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
] as const;

export async function publishTikTokVideo(
  tenantId: string,
  meta: { caption: string; privacy: TikTokPrivacy },
  signedUrl: string,
  opts: { pollDelayMs?: number; pollAttempts?: number } = {},
): Promise<TikTokPublishResult> {
  let publish_id: string;
  let creator_username: string | undefined;
  try {
    const creator = await queryCreatorInfo(tenantId);
    const allowed = creator?.data?.privacy_level_options as string[] | undefined;
    if (allowed && !allowed.includes(meta.privacy)) {
      return {
        ok: false,
        status: 400,
        raw: { error: `tiktok: creator no longer allows ${meta.privacy}`, allowed },
      };
    }
    const username = creator?.data?.creator_username;
    creator_username = typeof username === "string" && username ? username : undefined;

    let v: Response;
    try {
      v = await fetch(signedUrl, { signal: AbortSignal.timeout(120_000) });
    } catch (e) {
      return { ok: false, status: 502, raw: { error: "video_fetch_failed", message: (e as Error).message } };
    }
    if (!v.ok) return { ok: false, status: 400, raw: { error: `video fetch ${v.status}` } };
    const bytes = Buffer.from(await v.arrayBuffer());

    ({ publish_id } = await publishTikTokVideoBytes(
      tenantId,
      "/v2/post/publish/video/init/",
      { title: meta.caption, privacy_level: meta.privacy },
      bytes,
    ));
  } catch (e) {
    return tiktokFailure(e);
  }

  const attempts = opts.pollAttempts ?? PUBLISH_POLL_ATTEMPTS;
  const delay = opts.pollDelayMs ?? PUBLISH_POLL_DELAY_MS;
  let last: string | undefined;
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, delay));
    let data: Record<string, unknown> | undefined;
    try {
      data = (await fetchTikTokPostStatus(tenantId, publish_id))?.data;
    } catch (e) {
      const failure = tiktokFailure(e);
      if (failure.status === 400) {
        return { ok: false, status: 503, raw: { publish_id, status: last ?? null, error: "tiktok publish not confirmed", cause: failure.raw.error } };
      }
      continue;
    }
    last = typeof data?.status === "string" ? data.status : last;
    if (last === "PUBLISH_COMPLETE") {
      const ids = data?.publicaly_available_post_id ?? data?.publicly_available_post_id;
      return {
        ok: true,
        status: 200,
        raw: {
          publish_id,
          status: last,
          publicaly_available_post_id: Array.isArray(ids) ? ids.map(String) : [],
          ...(creator_username ? { creator_username } : {}),
        },
      };
    }
    if (last === "FAILED") {
      const fail_reason = typeof data?.fail_reason === "string" ? data.fail_reason : "unknown";
      if (fail_reason === TIKTOK_PRIVATE_ONLY) {
        return { ok: false, status: 400, raw: { publish_id, code: TIKTOK_PRIVATE_ONLY, error: TIKTOK_PRIVATE_ONLY, message: TIKTOK_PRIVATE_ONLY_MESSAGE, fail_reason } };
      }
      return { ok: false, status: 400, raw: { publish_id, error: "tiktok_publish_failed", fail_reason } };
    }
  }
  return { ok: false, status: 503, raw: { publish_id, status: last ?? null, error: "tiktok publish not confirmed" } };
}
