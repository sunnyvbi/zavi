import type { CardDeps, CardOutcome, EmailCardRail } from "@/services/email-cards/cards";

type CardRef = { rail: string; id: string } | null;
type Plan = { ok: boolean; items?: Array<{ card: CardRef }>; holds?: Array<{ rail: string; card_id: string }> };
type WithStatus<P> = P extends { items: Array<infer I>; holds: Array<infer H> }
  ? Omit<P, "items" | "holds"> & { items: Array<I & { card_status: CardOutcome | null }>; holds: Array<H & { card_status: CardOutcome | null }> }
  : P;

const RAILS: ReadonlySet<string> = new Set(["channel_actions", "decisions"]);

function once<T>(f: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= f());
}

export async function withCardStatus<P extends Plan>(tenantId: string, userId: string, plan: P, deps: Partial<CardDeps> = {}): Promise<WithStatus<P>> {
  if (!plan.ok) return plan as WithStatus<P>;
  const cards = await import("@/services/email-cards/cards");
  const paused = once(() => (deps.paused ?? cards.LIVE_CARD_DEPS.paused)(tenantId));
  const senderStop = once(() => (deps.senderStop ?? cards.LIVE_CARD_DEPS.senderStop)());
  const d: Partial<CardDeps> = { ...deps, paused: () => paused(), senderStop: () => senderStop() };
  const seen = new Map<string, Promise<CardOutcome | null>>();
  const statusOf = (rail: string, id: string): Promise<CardOutcome | null> => {
    if (!RAILS.has(rail)) return Promise.resolve(null);
    const key = `${rail}:${id}`;
    let p = seen.get(key);
    if (!p) {
      p = cards.readCardOutcome(tenantId, rail as EmailCardRail, id, userId, d).catch((): null => null);
      seen.set(key, p);
    }
    return p;
  };
  const items = await Promise.all((plan.items ?? []).map(async (i) => ({ ...i, card_status: i.card ? await statusOf(i.card.rail, i.card.id) : null })));
  const holds = await Promise.all((plan.holds ?? []).map(async (h) => ({ ...h, card_status: await statusOf(h.rail, h.card_id) })));
  return { ...plan, items, holds } as unknown as WithStatus<P>;
}
