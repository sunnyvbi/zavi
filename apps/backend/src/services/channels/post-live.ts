
import { getChannel } from "@zavi/shared";
import { SOCIAL_ACTION_CHANNEL_SLUG } from "@/routes/approvals/decision-channel";

export type PublishedPost = {
  id: string;
  tenant_id: string;
  agent_run_id: string | null;
  channel: string;
  externalUrl: string | null;
};

type OpenCard = { id: string; body: unknown; edited_body: unknown };

export type PostLiveDeps = {
  readPostTexts: (tenantId: string, postId: string) => Promise<string[]>;
  readOpenCards: (tenantId: string, runId: string, channelSlug: string) => Promise<OpenCard[]>;
  close: (tenantId: string, cardId: string, note: string, eventKey: string) => Promise<void>;
};

export function sameText(a: string, b: string): boolean {
  const fold = (s: string) => s.replace(/\s+/g, " ").trim();
  return fold(a).length > 0 && fold(a) === fold(b);
}

function cardTexts(c: OpenCard): string[] {
  const words = (body: unknown) => {
    const b = body as { text?: unknown; step?: { deliverable?: { content?: unknown } } } | null;
    return [b?.text, b?.step?.deliverable?.content].filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  };
  const e = c.edited_body;
  const hasEdit = !!e && typeof e === "object" && ("text" in e || "step" in e);
  return hasEdit ? words(e) : words(c.body);
}

const DEFAULT_DEPS: PostLiveDeps = {
  readPostTexts: async (tenantId, postId) => {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const db = tenantClient(asTenantId(tenantId));
    const post = await db.from("social_posts").select("decision_id").eq("id", postId).maybeSingle();
    if (post.error) throw new Error(`post-live: post read failed: ${post.error.message}`);
    const decisionId = (post.data as { decision_id?: string | null } | null)?.decision_id;
    if (!decisionId) return [];
    const d = await db.from("decisions").select("body").eq("id", decisionId).maybeSingle();
    if (d.error) throw new Error(`post-live: decision read failed: ${d.error.message}`);
    const body = (d.data as { body?: { payload?: { text?: unknown }; post_draft_original?: { payload?: { text?: unknown } } } } | null)?.body;
    return [body?.payload?.text, body?.post_draft_original?.payload?.text].filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  },
  readOpenCards: async (tenantId, runId, channelSlug) => {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("channel_actions")
      .select("id, body, edited_body")
      .eq("run_id", runId)
      .eq("channel_slug", channelSlug)
      .eq("card_kind", "post")
      .in("status", ["pending", "snoozed"])
      .is("exec_class", null)
      .limit(20);
    if (error) throw new Error(`post-live: card read failed: ${error.message}`);
    return (data ?? []) as OpenCard[];
  },
  close: async (tenantId, cardId, note, eventKey) => {
    const { asTenantId, tenantRpc } = await import("@/services/tenant-client");
    const { data, error } = await tenantRpc(asTenantId(tenantId), "set_channel_action", {
      p_action_id: cardId,
      p_status: "acted",
      p_note: note,
      p_snoozed_until: null,
      p_event_key: eventKey,
      p_actor_user_id: null,
      p_source: "cgo",
    });
    if (error) throw new Error(`post-live: close failed: ${error.message}`);
    const r = data as { ok?: boolean; code?: string } | null;
    if (r && r.ok === false && r.code !== "illegal_transition") throw new Error(`post-live: close refused: ${r.code ?? "unknown"}`);
  },
};

export async function closePostCardsForPublished(post: PublishedPost, deps: Partial<PostLiveDeps> = {}): Promise<number> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const slug = Object.hasOwn(SOCIAL_ACTION_CHANNEL_SLUG, post.channel) ? SOCIAL_ACTION_CHANNEL_SLUG[post.channel] : null;
  if (!slug || !post.agent_run_id) return 0;
  const live = await d.readPostTexts(post.tenant_id, post.id);
  if (live.length === 0) return 0;
  const platform = getChannel(slug)?.name ?? slug;
  const note = post.externalUrl ? `Posted on ${platform}: ${post.externalUrl}` : `Posted on ${platform}.`;
  let n = 0;
  for (const card of await d.readOpenCards(post.tenant_id, post.agent_run_id, slug)) {
    if (!cardTexts(card).some((w) => live.some((t) => sameText(w, t)))) continue;
    await d.close(post.tenant_id, card.id, note, `post-live:${post.id}:${card.id}`);
    n++;
  }
  return n;
}

export type PostedCard = { id: string; run_id: string; body: unknown; posted_at: string; line: string; url: string | null };

const POST_HOSTS: readonly string[] = ["linkedin.com", "x.com", "twitter.com", "reddit.com", "instagram.com", "youtube.com", "tiktok.com", "pinterest.com"];

export function safePostUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  return POST_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? u.toString() : null;
}

type ClosedPostCard = OpenCard & { run_id: string | null; status_at: string | null };
type LivePost = { agent_run_id: string | null; channel: string; created_at: string | null; updated_at: string; external_url: string | null; texts: string[] };

export const COMPOSER_POST_WINDOW_MS = 15 * 60_000;

function sameSource(card: ClosedPostCard, post: LivePost): boolean {
  if (post.agent_run_id) return post.agent_run_id === card.run_id;
  const closed = card.status_at ? Date.parse(card.status_at) : NaN;
  const filed = post.created_at ? Date.parse(post.created_at) : NaN;
  return Number.isFinite(closed) && Number.isFinite(filed) && Math.abs(closed - filed) <= COMPOSER_POST_WINDOW_MS;
}

export function matchPostedCards(channelSlug: string, cards: readonly ClosedPostCard[], posts: readonly LivePost[]): PostedCard[] {
  const platform = getChannel(channelSlug)?.name ?? channelSlug;
  const gap = (card: ClosedPostCard, p: LivePost) => Math.abs(Date.parse(card.status_at ?? "") - Date.parse(p.created_at ?? p.updated_at));
  const out: PostedCard[] = [];
  for (const card of cards) {
    const words = cardTexts(card);
    const hits = posts
      .filter((p) => Object.hasOwn(SOCIAL_ACTION_CHANNEL_SLUG, p.channel) && SOCIAL_ACTION_CHANNEL_SLUG[p.channel] === channelSlug)
      .filter((p) => sameSource(card, p))
      .filter((p) => Number.isFinite(Date.parse(p.updated_at)) && words.some((w) => p.texts.some((t) => sameText(w, t))))
      .sort((a, b) => (gap(card, a) || 0) - (gap(card, b) || 0));
    if (hits.length === 0) continue;
    out.push({ id: card.id, run_id: card.run_id ?? "", body: card.body, posted_at: hits[0].updated_at, line: `Posted on ${platform}.`, url: safePostUrl(hits[0].external_url) });
  }
  return out;
}

export async function readPostedCards(tenantId: string, channelSlug: string, scope: { sinceIso: string } | { ids: readonly string[] }): Promise<PostedCard[]> {
  if ("ids" in scope && scope.ids.length === 0) return [];
  const keys = Object.entries(SOCIAL_ACTION_CHANNEL_SLUG).filter(([, slug]) => slug === channelSlug).map(([key]) => key);
  if (keys.length === 0) return [];
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const tid = asTenantId(tenantId);
  const db = tenantClient(tid);
  const base = db
    .from("channel_actions")
    .select("id, run_id, status_at, body, edited_body")
    .eq("tenant_id", tid)
    .eq("channel_slug", channelSlug)
    .eq("card_kind", "post")
    .eq("status", "acted")
    .is("exec_class", null);
  const cardsRead = await ("ids" in scope ? base.in("id", [...scope.ids]) : base.gte("status_at", scope.sinceIso))
    .order("status_at", { ascending: false })
    .limit(1000);
  if (cardsRead.error) throw new Error(`posted cards read failed: ${cardsRead.error.message}`);
  const cards = (cardsRead.data ?? []) as ClosedPostCard[];
  if (cards.length === 0) return [];
  const POST_COLUMNS = "decision_id, agent_run_id, channel, created_at, updated_at, external_url";
  type PostRow = { decision_id: string | null; agent_run_id: string | null; channel: string; created_at: string | null; updated_at: string; external_url: string | null };
  const posts: PostRow[] = [];
  const runIds = [...new Set(cards.map((c) => c.run_id).filter((r): r is string => typeof r === "string" && r.length > 0))];
  for (let i = 0; i < runIds.length; i += 100) {
    const r = await db
      .from("social_posts")
      .select(POST_COLUMNS)
      .eq("tenant_id", tid)
      .in("agent_run_id", runIds.slice(i, i + 100))
      .eq("status", "published")
      .limit(1000);
    if (r.error) throw new Error(`posted cards posts read failed: ${r.error.message}`);
    posts.push(...((r.data ?? []) as PostRow[]));
  }
  const closedAt = cards.map((c) => (c.status_at ? Date.parse(c.status_at) : NaN)).filter((t) => Number.isFinite(t));
  if (closedAt.length > 0) {
    const r = await db
      .from("social_posts")
      .select(POST_COLUMNS)
      .eq("tenant_id", tid)
      .is("agent_run_id", null)
      .in("channel", keys)
      .eq("status", "published")
      .gte("created_at", new Date(Math.min(...closedAt) - COMPOSER_POST_WINDOW_MS).toISOString())
      .lte("created_at", new Date(Math.max(...closedAt) + COMPOSER_POST_WINDOW_MS).toISOString())
      .limit(1000);
    if (r.error) throw new Error(`posted cards posts read failed: ${r.error.message}`);
    posts.push(...((r.data ?? []) as PostRow[]).filter((p) => p.agent_run_id == null));
  }
  const decisionIds = [...new Set(posts.map((p) => p.decision_id).filter((d): d is string => typeof d === "string"))];
  const texts = new Map<string, string[]>();
  for (let i = 0; i < decisionIds.length; i += 100) {
    const r = await db.from("decisions").select("id, body").eq("tenant_id", tid).in("id", decisionIds.slice(i, i + 100));
    if (r.error) throw new Error(`posted cards decisions read failed: ${r.error.message}`);
    for (const d of (r.data ?? []) as Array<{ id: string; body?: { payload?: { text?: unknown }; post_draft_original?: { payload?: { text?: unknown } } } | null }>) {
      texts.set(d.id, [d.body?.payload?.text, d.body?.post_draft_original?.payload?.text].filter((t): t is string => typeof t === "string" && t.trim().length > 0));
    }
  }
  return matchPostedCards(
    channelSlug,
    cards,
    posts.map((p) => ({ ...p, texts: p.decision_id ? texts.get(p.decision_id) ?? [] : [] })),
  );
}
