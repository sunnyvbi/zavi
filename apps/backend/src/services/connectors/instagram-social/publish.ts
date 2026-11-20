
import { getSecret } from "@/services/secrets/vault";
import { getConnectorToken } from "@/services/connectors/core/token";
import {
  INSTAGRAM_GRAPH_URL,
  INSTAGRAM_GRAPH_VERSION,
  INSTAGRAM_SOCIAL_ACCESS_TOKEN_KEY,
  INSTAGRAM_SOCIAL_SLUG,
  INSTAGRAM_SOCIAL_USER_ID_KEY,
} from "./constants";

export type InstagramPublishResult = {
  ok: boolean;
  status: number;
  raw: Record<string, unknown>;
};

const CAPTION_MAX = 2200;
const POLL_ATTEMPTS = 10;
const VIDEO_POLL_ATTEMPTS = 60;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function creds(tenantId: string): Promise<{ token: string; userId: string }> {
  const [token, userId] = await Promise.all([
    getConnectorToken(tenantId, INSTAGRAM_SOCIAL_SLUG, INSTAGRAM_SOCIAL_ACCESS_TOKEN_KEY),
    getSecret(tenantId, INSTAGRAM_SOCIAL_USER_ID_KEY),
  ]);
  if (!token || !userId) throw new Error("instagram_social not connected");
  return { token, userId };
}

function graph(path: string): string {
  return `${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_GRAPH_VERSION}/${path}`;
}

async function call(
  token: string,
  url: string,
  init: { method?: "GET" | "POST"; form?: Record<string, string> } = {},
): Promise<{ resp: Response; json: Record<string, unknown> }> {
  const resp = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init.form ? new URLSearchParams(init.form).toString() : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await resp.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { resp, json };
}

export async function publishInstagramImage(
  tenantId: string,
  caption: string,
  imageUrl: string,
  opts: { pollDelayMs?: number } = {},
): Promise<InstagramPublishResult> {
  return publishContainer(tenantId, caption, { image_url: imageUrl }, POLL_ATTEMPTS, opts.pollDelayMs ?? 2_000);
}

export async function publishInstagramVideo(
  tenantId: string,
  caption: string,
  videoUrl: string,
  opts: { pollDelayMs?: number } = {},
): Promise<InstagramPublishResult> {
  return publishContainer(tenantId, caption, { media_type: "REELS", video_url: videoUrl }, VIDEO_POLL_ATTEMPTS, opts.pollDelayMs ?? 5_000);
}

async function publishContainer(
  tenantId: string,
  caption: string,
  media: Record<string, string>,
  attempts: number,
  pollDelayMs: number,
): Promise<InstagramPublishResult> {
  const { token, userId } = await creds(tenantId);

  const c = await call(token, graph(`${userId}/media`), {
    method: "POST",
    form: { ...media, caption: caption.slice(0, CAPTION_MAX) },
  });
  const creationId = c.json.id !== undefined ? String(c.json.id) : "";
  if (!c.resp.ok || !creationId) {
    return { ok: false, status: c.resp.ok ? 400 : c.resp.status, raw: c.json };
  }

  let finished = false;
  for (let i = 0; i < attempts; i++) {
    const s = await call(token, graph(`${creationId}?fields=status_code,status`));
    const code = typeof s.json.status_code === "string" ? s.json.status_code : "";
    if (code === "FINISHED") {
      finished = true;
      break;
    }
    if (code === "ERROR" || code === "EXPIRED" || !s.resp.ok) {
      return { ok: false, status: s.resp.ok ? 400 : s.resp.status, raw: { creation_id: creationId, ...s.json } };
    }
    if (i < attempts - 1) await sleep(pollDelayMs);
  }
  if (!finished) {
    return { ok: false, status: 503, raw: { creation_id: creationId, error: "instagram container not ready" } };
  }

  const p = await call(token, graph(`${userId}/media_publish`), {
    method: "POST",
    form: { creation_id: creationId },
  });
  const mediaId = p.json.id !== undefined ? String(p.json.id) : "";
  if (!p.resp.ok || !mediaId) {
    return { ok: false, status: p.resp.ok ? 400 : p.resp.status, raw: { creation_id: creationId, ...p.json } };
  }

  const raw: Record<string, unknown> = { id: mediaId };
  try {
    const l = await call(token, graph(`${mediaId}?fields=permalink`));
    if (l.resp.ok && typeof l.json.permalink === "string") raw.permalink = l.json.permalink;
  } catch {
  }
  return { ok: true, status: p.resp.status, raw };
}

export async function isInstagramSocialConnected(tenantId: string): Promise<boolean> {
  try {
    const { token, userId } = await creds(tenantId);
    return Boolean(token && userId);
  } catch {
    return false;
  }
}
