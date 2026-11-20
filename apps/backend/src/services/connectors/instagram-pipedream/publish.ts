
import { proxyRequest } from "@/services/connectors/pipedream/api";

export const IG_PIPEDREAM_APP = "instagram_business";
export const GRAPH = "https://graph.facebook.com/v25.0";
const CAPTION_MAX = 2200;
const POLL_ATTEMPTS = 10;

export type IgPublishResult = { ok: boolean; status: number; raw: Record<string, unknown> };

type Ctx = { tenantId: string; accountId: string };

function q(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

async function graph(ctx: Ctx, method: "GET" | "POST", path: string, params: Record<string, string> = {}) {
  return proxyRequest({
    external_user_id: ctx.tenantId,
    app_slug: IG_PIPEDREAM_APP,
    account_id: ctx.accountId,
    method,
    url: q(`${GRAPH}/${path}`, params),
  });
}

export async function resolveIgUserId(ctx: Ctx): Promise<{ ok: true; igUserId: string; pageName: string } | { ok: false; status: number; raw: Record<string, unknown> }> {
  const r = await graph(ctx, "GET", "me/accounts", { fields: "name,instagram_business_account", limit: "50" });
  if (!r.ok) return { ok: false, status: r.status, raw: r.json };
  const pages = (r.json.data as Array<{ name?: string; instagram_business_account?: { id?: string } }> | undefined) ?? [];
  const page = pages.find((p) => p.instagram_business_account?.id);
  if (!page) {
    return {
      ok: false,
      status: 400,
      raw: { error: "no Facebook Page with a linked Instagram professional account — link them at facebook.com/business/help/connect-instagram-to-page" },
    };
  }
  return { ok: true, igUserId: String(page.instagram_business_account!.id), pageName: page.name ?? "" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function publishInstagramImageViaPipedream(
  tenantId: string,
  accountId: string,
  caption: string,
  imageUrl: string,
  opts: { pollDelayMs?: number } = {},
): Promise<IgPublishResult> {
  const ctx = { tenantId, accountId };
  const who = await resolveIgUserId(ctx);
  if (!who.ok) return { ok: false, status: who.status, raw: who.raw };
  const pollDelayMs = opts.pollDelayMs ?? 2_000;

  const c = await graph(ctx, "POST", `${who.igUserId}/media`, {
    image_url: imageUrl,
    caption: caption.slice(0, CAPTION_MAX),
  });
  const creationId = c.json.id !== undefined ? String(c.json.id) : "";
  if (!c.ok || !creationId) return { ok: false, status: c.ok ? 400 : c.status, raw: c.json };

  let finished = false;
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const st = await graph(ctx, "GET", creationId, { fields: "status_code,status" });
    const code = typeof st.json.status_code === "string" ? st.json.status_code : "";
    if (code === "FINISHED") {
      finished = true;
      break;
    }
    if (code === "ERROR" || code === "EXPIRED" || !st.ok) {
      return { ok: false, status: st.ok ? 400 : st.status, raw: { creation_id: creationId, ...st.json } };
    }
    if (i < POLL_ATTEMPTS - 1) await sleep(pollDelayMs);
  }
  if (!finished) return { ok: false, status: 503, raw: { creation_id: creationId, error: "instagram container not ready" } };

  const p = await graph(ctx, "POST", `${who.igUserId}/media_publish`, { creation_id: creationId });
  const mediaId = p.json.id !== undefined ? String(p.json.id) : "";
  if (!p.ok || !mediaId) return { ok: false, status: p.ok ? 400 : p.status, raw: { creation_id: creationId, ...p.json } };

  const raw: Record<string, unknown> = { id: mediaId, transport: "pipedream" };
  try {
    const l = await graph(ctx, "GET", mediaId, { fields: "permalink" });
    if (l.ok && typeof l.json.permalink === "string") raw.permalink = l.json.permalink;
  } catch {
  }
  return { ok: true, status: p.status, raw };
}
