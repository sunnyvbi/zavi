import { composioProxy, type OwnedComposioAccount } from "@/services/connectors/composio/api";
import { INSTAGRAM_GRAPH_URL, INSTAGRAM_GRAPH_VERSION } from "@/services/connectors/instagram-social/constants";

const CAPTION_MAX = 2200;
const POLL_ATTEMPTS = 10;
const VIDEO_POLL_ATTEMPTS = 60;
export type IgComposioResult = { ok: boolean; status: number; raw: Record<string, unknown> };

const g = (path: string, q: Record<string, string> = {}) => {
  const u = new URL(`${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_GRAPH_VERSION}/${path}`);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function publishInstagramImageViaComposio(
  account: OwnedComposioAccount, caption: string, imageUrl: string, opts: { pollDelayMs?: number } = {},
): Promise<IgComposioResult> {
  return publishContainer(account, caption, { image_url: imageUrl }, POLL_ATTEMPTS, opts.pollDelayMs ?? 2_000);
}

export async function publishInstagramVideoViaComposio(
  account: OwnedComposioAccount, caption: string, videoUrl: string, opts: { pollDelayMs?: number } = {},
): Promise<IgComposioResult> {
  return publishContainer(account, caption, { media_type: "REELS", video_url: videoUrl }, VIDEO_POLL_ATTEMPTS, opts.pollDelayMs ?? 5_000);
}

async function publishContainer(
  account: OwnedComposioAccount, caption: string, media: Record<string, string>, attempts: number, pollDelayMs: number,
): Promise<IgComposioResult> {
  const call = (method: "GET" | "POST", endpoint: string) => composioProxy({ account, method, endpoint });
  const me = await call("GET", g("me", { fields: "user_id,username" }));
  const igId = String(me.json.user_id ?? me.json.id ?? "");
  if (!me.ok || !igId) return { ok: false, status: me.ok ? 400 : me.status, raw: me.json };

  const c = await call("POST", g(`${igId}/media`, { ...media, caption: caption.slice(0, CAPTION_MAX) }));
  const creationId = c.json.id !== undefined ? String(c.json.id) : "";
  if (!c.ok || !creationId) return { ok: false, status: c.ok ? 400 : c.status, raw: c.json };

  let finished = false;
  for (let i = 0; i < attempts; i++) {
    const s = await call("GET", g(creationId, { fields: "status_code,status" }));
    const code = typeof s.json.status_code === "string" ? s.json.status_code : "";
    if (code === "FINISHED") { finished = true; break; }
    if (code === "ERROR" || code === "EXPIRED" || !s.ok) {
      return { ok: false, status: s.ok ? 400 : s.status, raw: { creation_id: creationId, ...s.json } };
    }
    if (i < attempts - 1) await sleep(pollDelayMs);
  }
  if (!finished) return { ok: false, status: 503, raw: { creation_id: creationId, error: "instagram container not ready" } };

  const p = await call("POST", g(`${igId}/media_publish`, { creation_id: creationId }));
  const mediaId = p.json.id !== undefined ? String(p.json.id) : "";
  if (!p.ok || !mediaId) return { ok: false, status: p.ok ? 400 : p.status, raw: { creation_id: creationId, ...p.json } };

  const raw: Record<string, unknown> = { id: mediaId };
  const l = await call("GET", g(mediaId, { fields: "permalink" }));
  if (l.ok && typeof l.json.permalink === "string") raw.permalink = l.json.permalink;
  return { ok: true, status: p.status, raw };
}
