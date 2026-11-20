
import { forceRefreshConnector, getConnectorToken } from "@/services/connectors/core/token";
import { X_SOCIAL_ACCESS_TOKEN_KEY, X_SOCIAL_SLUG } from "./constants";
import { resolveChannelAction, xPostTextSchema } from "../social-channels";

const TWEETS_URL = "https://api.x.com/2/tweets";

export type XPublishResult = { ok: boolean; status: number; raw: Record<string, unknown> };

type TweetBody = {
  text: string;
  reply?: { in_reply_to_tweet_id: string };
  media?: { media_ids: string[] };
};

export async function publishXText(tenantId: string, text: string): Promise<XPublishResult> {
  const checked = xPostTextSchema.safeParse(text);
  if (!checked.success) return { ok: false, status: 422, raw: { error: checked.error.issues[0]?.message } };
  return postTweet(tenantId, { text });
}

export async function publishXThread(
  tenantId: string,
  text: string,
  parts: readonly string[],
): Promise<XPublishResult> {
  const checked = resolveChannelAction("x").payload_schema.safeParse({ text, ...(parts.length ? { thread: parts } : {}) });
  if (!checked.success) return { ok: false, status: 422, raw: { error: checked.error.issues[0]?.message } };
  const root = await publishXText(tenantId, text);
  const rootId = typeof root.raw.id === "string" ? root.raw.id : null;
  if (!root.ok || !rootId) return root;
  const thread_ids: string[] = [];
  let prev = rootId;
  for (let i = 0; i < parts.length; i++) {
    const r = await postTweet(tenantId, {
      text: parts[i],
      reply: { in_reply_to_tweet_id: prev },
    }).catch((error: unknown): XPublishResult => ({
      ok: false, status: 0,
      raw: { error: error instanceof Error ? error.message : "X did not return a response" },
    }));
    const id = typeof r.raw.id === "string" ? r.raw.id : null;
    if (!r.ok || !id) {
      return {
        ok: true,
        status: root.status,
        raw: { ...root.raw, thread_ids, thread_error: { index: i, status: r.status, body: r.raw } },
      };
    }
    thread_ids.push(id);
    prev = id;
  }
  return { ok: true, status: root.status, raw: { ...root.raw, thread_ids } };
}

const MEDIA_URL = "https://api.x.com/2/media/upload";
const SEGMENT_BYTES = 4 * 1024 * 1024;
const STATUS_POLL_CAP_MS = 120_000;

export type XMediaKind = "image" | "video";

function mediaTypeFor(kind: XMediaKind, url: string): string {
  if (kind === "video") return "video/mp4";
  const ext = (url.split("?")[0].match(/\.(png|jpe?g|webp|gif)$/i)?.[1] ?? "jpg").toLowerCase();
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
}

async function xJson(resp: Response): Promise<Record<string, unknown>> {
  try {
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return { body: await resp.text().catch(() => "") };
  }
}

export async function uploadXMedia(
  bearer: string,
  bytes: Buffer,
  mediaType: string,
  category: "tweet_image" | "tweet_video" | "tweet_gif",
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ ok: true; media_id: string } | { ok: false; status: number; raw: Record<string, unknown> }> {
  const auth = { Authorization: `Bearer ${bearer}` };
  const init = await fetch(`${MEDIA_URL}/initialize`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ media_type: mediaType, total_bytes: bytes.length, media_category: category }),
    signal: AbortSignal.timeout(30_000),
  });
  const initBody = await xJson(init);
  const mediaId = (initBody.data as { id?: string } | undefined)?.id;
  if (!init.ok || !mediaId) return { ok: false, status: init.status, raw: { step: "initialize", ...initBody } };

  for (let i = 0, seg = 0; i < bytes.length; i += SEGMENT_BYTES, seg++) {
    const form = new FormData();
    form.append("segment_index", String(seg));
    form.append("media", new Blob([bytes.subarray(i, i + SEGMENT_BYTES)], { type: mediaType }), "media");
    const append = await fetch(`${MEDIA_URL}/${mediaId}/append`, {
      method: "POST",
      headers: auth,
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!append.ok) return { ok: false, status: append.status, raw: { step: "append", segment: seg, ...(await xJson(append)) } };
  }

  const fin = await fetch(`${MEDIA_URL}/${mediaId}/finalize`, {
    method: "POST",
    headers: { ...auth, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const finBody = await xJson(fin);
  if (!fin.ok) return { ok: false, status: fin.status, raw: { step: "finalize", ...finBody } };

  let info = (finBody.data as { processing_info?: { state?: string; check_after_secs?: number } } | undefined)?.processing_info;
  const started = Date.now();
  while (info && (info.state === "pending" || info.state === "in_progress")) {
    if (Date.now() - started > STATUS_POLL_CAP_MS) {
      return { ok: false, status: 504, raw: { step: "status", error: "media processing did not finish in time" } };
    }
    await sleep(Math.min(Math.max(info.check_after_secs ?? 1, 1), 15) * 1000);
    const st = await fetch(`${MEDIA_URL}?command=STATUS&media_id=${encodeURIComponent(mediaId)}`, {
      headers: { ...auth, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    const stBody = await xJson(st);
    if (!st.ok) return { ok: false, status: st.status, raw: { step: "status", ...stBody } };
    info = (stBody.data as { processing_info?: { state?: string; check_after_secs?: number } } | undefined)?.processing_info;
  }
  if (info?.state === "failed") return { ok: false, status: 422, raw: { step: "status", processing_info: info } };
  return { ok: true, media_id: mediaId };
}

export async function publishXMedia(
  tenantId: string,
  text: string,
  mediaUrl: string,
  kind: XMediaKind,
): Promise<XPublishResult> {
  const checked = xPostTextSchema.safeParse(text);
  if (!checked.success) return { ok: false, status: 422, raw: { error: checked.error.issues[0]?.message } };
  let token: string | null;
  try {
    token = await getConnectorToken(tenantId, X_SOCIAL_SLUG, X_SOCIAL_ACCESS_TOKEN_KEY);
  } catch (e) {
    return { ok: false, status: 502, raw: { error: `x_social token read failed: ${(e as Error).message}` } };
  }
  if (!token) return { ok: false, status: 401, raw: { error: "x_social not connected" } };
  let bytes: Buffer;
  try {
    const src = await fetch(mediaUrl, { signal: AbortSignal.timeout(120_000) });
    if (!src.ok) return { ok: false, status: 400, raw: { error: `media fetch ${src.status}` } };
    bytes = Buffer.from(await src.arrayBuffer());
  } catch (e) {
    return { ok: false, status: 502, raw: { error: `media fetch failed: ${(e as Error).message}` } };
  }
  const mediaType = mediaTypeFor(kind, mediaUrl);
  const category = kind === "video" ? "tweet_video" : mediaType === "image/gif" ? "tweet_gif" : "tweet_image";
  const upload = (bearer: string) =>
    uploadXMedia(bearer, bytes, mediaType, category).catch(
      (e: unknown) => ({ ok: false as const, status: 502, raw: { step: "upload", error: (e as Error).message } }),
    );
  let up = await upload(token);
  if (!up.ok && up.status === 401) {
    await forceRefreshConnector(tenantId, X_SOCIAL_SLUG).catch(() => undefined);
    const next = await getConnectorToken(tenantId, X_SOCIAL_SLUG, X_SOCIAL_ACCESS_TOKEN_KEY).catch(() => null);
    if (next && next !== token) up = await upload(next);
  }
  if (!up.ok) return { ok: false, status: up.status, raw: up.raw };
  const post = await postTweet(tenantId, { text, media: { media_ids: [up.media_id] } });
  return { ...post, raw: { ...post.raw, media_id: up.media_id } };
}

async function postTweet(tenantId: string, req: TweetBody): Promise<XPublishResult> {
  const token = await getConnectorToken(tenantId, X_SOCIAL_SLUG, X_SOCIAL_ACCESS_TOKEN_KEY);
  if (!token) throw new Error("x_social not connected");

  const post = (bearer: string) =>
    fetch(TWEETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(30_000),
    });
  let resp = await post(token);
  if (resp.status === 401) {
    await forceRefreshConnector(tenantId, X_SOCIAL_SLUG).catch(() => undefined);
    const next = await getConnectorToken(tenantId, X_SOCIAL_SLUG, X_SOCIAL_ACCESS_TOKEN_KEY).catch(() => null);
    if (next && next !== token) resp = await post(next);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await resp.json()) as Record<string, unknown>;
  } catch {
    body = { body: await resp.text().catch(() => "") };
  }
  const raw: Record<string, unknown> = { ...body };
  const data = body.data as { id?: string } | undefined;
  if (data?.id) raw.id = data.id;
  return { ok: resp.ok, status: resp.status, raw };
}

export async function isXSocialConnected(tenantId: string): Promise<boolean> {
  const token = await getConnectorToken(tenantId, X_SOCIAL_SLUG, X_SOCIAL_ACCESS_TOKEN_KEY).catch(() => null);
  return Boolean(token);
}
