
import { adCardTitle, adChangeHeadline, decisionHomeFromStamp, getChannel, isGrowthChannelSlug } from "@zavi/shared";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveChatTurnChain, type ChatTurnChain } from "@/services/agents/run-owner";
import { emitThreadEvent } from "@/services/agents/thread-event";
import { DecisionBodySchema, type ThreadEventBody } from "@/services/agents/thread-event-types";
import { logEvent } from "@/services/logging/logEvent";
import { homePhrase } from "./card-location";
import { parseFounderMessageRef } from "./founder-message";
import { GROWTH_PAGE_ONLY_NOT_IN, isGrowthPageOnlyClass } from "./growth-page-only";
import { moveKeyOf } from "@/services/growth/move-card";

export type CardTable = "decisions" | "channel_actions";

export type ChatCardTarget = { thread_id: string; run_id: string; agent_slug: string };

export type OpenCard = {
  card_id: string;
  table: CardTable;
  what: string;
  where: string;
  filed_at: string | null;
  move_key: string | null;
};

export type AttachResult =
  | { shown: true; already: boolean; card_id: string; table: CardTable; what: string; move_key?: string }
  | { shown: false; reason: "not_chat" | "not_found" | "not_waiting" | "growth_page_only"; card_id: string; approved_by_source?: string | null };

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export async function chatCardTarget(tenant_id: string, run_id: string): Promise<ChatCardTarget | null> {
  const db = tenantClient(asTenantId(tenant_id)) as unknown as Pick<SupabaseClient, "from">;
  const chain = await resolveChatTurnChain(db, tenant_id, run_id);
  if (chain.ok) return turnTarget(tenant_id, chain);
  if (chain.reason !== "not_chat") return null;
  const parent = await handoffParentTurn(db, tenant_id, run_id);
  if (!parent) return null;
  const root = await resolveChatTurnChain(db, tenant_id, parent.run_id);
  if (!root.ok || root.thread_id !== parent.thread_id || root.root_enqueued_by !== parent.author_user_id) return null;
  return turnTarget(tenant_id, root);
}

async function handoffParentTurn(
  db: Pick<SupabaseClient, "from">,
  tenant_id: string,
  run_id: string,
): Promise<{ run_id: string; thread_id: string; author_user_id: string | null } | null> {
  const { data, error } = await db.from("agent_runs").select("trigger, enqueued_by, payload").eq("id", run_id).eq("tenant_id", tenant_id).maybeSingle();
  if (error) throw new Error(`run read failed: ${error.message}`);
  const run = data as { trigger?: unknown; enqueued_by?: unknown; payload?: unknown } | null;
  if (!run || run.trigger !== "handoff" || run.enqueued_by != null) return null;
  const payload = obj(run.payload);
  const thread_id = str(payload.operator_thread_id);
  const ref = parseFounderMessageRef(payload.founder_message_ref);
  if (!thread_id || ref?.kind !== "chat") return null;
  return { run_id: ref.run_id, thread_id, author_user_id: ref.author_user_id };
}

async function turnTarget(tenant_id: string, chain: Extract<ChatTurnChain, { ok: true }>): Promise<ChatCardTarget | null> {
  if (obj(chain.root_payload).origin === "staff_console") return null;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_threads")
    .select("agent_slug")
    .eq("tenant_id", tenant_id)
    .eq("id", chain.thread_id)
    .maybeSingle();
  if (error) throw new Error(`thread read failed: ${error.message}`);
  const agent_slug = str((data as { agent_slug?: unknown } | null)?.agent_slug);
  if (!agent_slug) return null;
  return { thread_id: chain.thread_id, run_id: chain.root_run_id, agent_slug };
}

export type Card = {
  table: CardTable;
  id: string;
  decision_class: string;
  waiting: boolean;
  approved_by_source: string | null;
  title: string;
  where: string;
  channel_slug: string | null;
  growth_page_only: boolean;
  filed_at: string | null;
  run_id: string | null;
  move_key: string | null;
};

const nowIso = () => new Date().toISOString();

function decisionWaiting(r: { status?: unknown; autonomy_at_emit?: unknown; snoozed_until?: unknown }): boolean {
  if (r.status !== "proposed" || r.autonomy_at_emit !== "approval") return false;
  const snooze = str(r.snoozed_until);
  return !snooze || Date.parse(snooze) <= Date.now();
}

function channelWaiting(r: { status?: unknown; snoozed_until?: unknown; exec_status?: unknown }): boolean {
  if (r.exec_status != null) return false;
  if (r.status === "pending") return true;
  if (r.status !== "snoozed") return false;
  const snooze = str(r.snoozed_until);
  return !snooze || Date.parse(snooze) <= Date.now();
}

function decisionCard(r: Record<string, unknown>): Card {
  const cls = str(r.decision_class) ?? "";
  const body = obj(r.body);
  return {
    table: "decisions",
    id: String(r.id),
    decision_class: cls,
    waiting: decisionWaiting(r),
    approved_by_source: str(r.approved_by_source),
    title: (adChangeHeadline(cls, body) ?? str(body.title) ?? str(body.summary) ?? cls).slice(0, 280),
    where: homePhrase(decisionHomeFromStamp({ decision_class: cls, home: str(r.home), home_channel: str(r.home_channel) })),
    channel_slug: null,
    growth_page_only: isGrowthPageOnlyClass(cls),
    filed_at: str(r.emitted_at),
    run_id: str(r.agent_run_id),
    move_key: moveKeyOf(body),
  };
}

function channelCard(r: Record<string, unknown>): Card {
  const slug = str(r.channel_slug);
  const body = obj(r.body);
  const step = obj(body.step);
  const title = adCardTitle({ title: str(r.title) ?? str(step.title), exec_class: str(r.exec_class), exec_payload: r.exec_payload });
  return {
    table: "channel_actions",
    id: String(r.id),
    decision_class: "channel.recipe_step",
    waiting: channelWaiting(r),
    approved_by_source: str(r.approved_by_source),
    title: (title || "A card waiting for you").slice(0, 280),
    where: slug && isGrowthChannelSlug(slug) ? `on the ${getChannel(slug)?.name ?? slug} channel page` : "on its channel page",
    channel_slug: slug,
    growth_page_only: false,
    filed_at: str(r.proposed_at),
    run_id: null,
    move_key: null,
  };
}

const DECISION_COLS = "id, decision_class, body, status, autonomy_at_emit, snoozed_until, approved_by_source, home, home_channel, emitted_at, agent_run_id";
const CHANNEL_COLS = "id, channel_slug, title, body, status, snoozed_until, exec_status, exec_class, exec_payload, approved_by_source, proposed_at";

export async function readCard(tenant_id: string, card_id: string, table?: CardTable): Promise<Card | null> {
  const db = tenantClient(asTenantId(tenant_id));
  if (table !== "channel_actions") {
    const { data, error } = await db.from("decisions").select(DECISION_COLS).eq("tenant_id", tenant_id).eq("id", card_id).maybeSingle();
    if (error) throw new Error(`decision read failed: ${error.message}`);
    if (data) return decisionCard(data as Record<string, unknown>);
    if (table === "decisions") return null;
  }
  const { data, error } = await db.from("channel_actions").select(CHANNEL_COLS).eq("tenant_id", tenant_id).eq("id", card_id).maybeSingle();
  if (error) throw new Error(`channel card read failed: ${error.message}`);
  return data ? channelCard(data as Record<string, unknown>) : null;
}

export type ShownCard = { id: string; full: boolean; body?: Record<string, unknown> };

async function shownInThread(tenant_id: string, thread_id: string, card_id: string): Promise<ShownCard | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("thread_event")
    .select("id, body")
    .eq("tenant_id", tenant_id)
    .eq("thread_id", thread_id)
    .eq("kind", "decision")
    .eq("body->>decision_id", card_id)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(`thread_event read failed: ${error.message}`);
  const rows = ((data ?? []) as Array<{ id?: unknown; body?: unknown }>).filter((r) => r.id != null);
  if (rows.length === 0) return null;
  const full = rows.find((r) => obj(r.body).full_card === true);
  const pick = full ?? rows[0];
  return { id: String(pick.id), full: !!full, body: obj(pick.body) };
}

async function rewriteShown(
  tenant_id: string,
  event_id: string,
  patch: { body?: ThreadEventBody<"decision">; toTarget?: ChatCardTarget },
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.body) update.body = patch.body;
  if (patch.toTarget) {
    update.created_at = new Date().toISOString();
    update.agent_run_id = patch.toTarget.run_id;
    update.agent_slug = patch.toTarget.agent_slug;
  }
  if (Object.keys(update).length === 0) return;
  const { error } = await tenantClient(asTenantId(tenant_id)).from("thread_event").update(update).eq("tenant_id", tenant_id).eq("id", event_id);
  if (error) throw new Error(`thread_event rewrite failed: ${error.message}`);
}

export type CardOrigin = { filed_at: string; from_other_chat: true };

export function attachedCardBody(
  card: Pick<Card, "id" | "table" | "decision_class" | "title" | "channel_slug">,
  origin?: CardOrigin | null,
): ThreadEventBody<"decision"> {
  return DecisionBodySchema.parse({
    decision_id: card.id,
    decision_class: card.decision_class.slice(0, 128),
    title: card.title,
    full_card: true,
    ...(card.table === "channel_actions" ? { store: "channel_action", ...(card.channel_slug ? { channel_slug: card.channel_slug.slice(0, 64) } : {}) } : {}),
    ...(origin ? { filed_at: origin.filed_at, from_other_chat: true } : {}),
  }) as ThreadEventBody<"decision">;
}

function withOrigin(card: Card, shown: ShownCard, origin: CardOrigin): ThreadEventBody<"decision"> {
  const kept = DecisionBodySchema.safeParse({ ...(shown.body ?? {}), filed_at: origin.filed_at, from_other_chat: true });
  return kept.success && shown.full ? (kept.data as ThreadEventBody<"decision">) : attachedCardBody(card, origin);
}

async function originOf(card: Card, target: ChatCardTarget, readTarget: typeof chatCardTarget, tenant_id: string): Promise<CardOrigin | null> {
  if (!card.run_id || !card.filed_at || Number.isNaN(Date.parse(card.filed_at))) return null;
  const from = await readTarget(tenant_id, card.run_id).catch(() => null);
  if (!from || from.thread_id === target.thread_id) return null;
  return { filed_at: new Date(Date.parse(card.filed_at)).toISOString(), from_other_chat: true };
}

export type AttachDeps = {
  target: typeof chatCardTarget;
  read: typeof readCard;
  shown: typeof shownInThread;
  emit: typeof emitThreadEvent;
  rewrite: typeof rewriteShown;
};

const DEFAULT_DEPS: AttachDeps = { target: chatCardTarget, read: readCard, shown: shownInThread, emit: emitThreadEvent, rewrite: rewriteShown };

export async function attachCardToChat(
  args: {
    tenant_id: string;
    run_id: string;
    card_id: string;
    table?: CardTable;
    bringToLatest?: boolean;
  },
  deps: Partial<AttachDeps> = {},
): Promise<AttachResult> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const target = await d.target(args.tenant_id, args.run_id);
  if (!target) return { shown: false, reason: "not_chat", card_id: args.card_id };
  const card = await d.read(args.tenant_id, args.card_id, args.table);
  if (!card) return { shown: false, reason: "not_found", card_id: args.card_id };
  if (card.growth_page_only) return { shown: false, reason: "growth_page_only", card_id: card.id };
  if (!card.waiting) return { shown: false, reason: "not_waiting", card_id: card.id, approved_by_source: card.approved_by_source };
  const log = (code: string) =>
    void logEvent({ level: "info", source: "chat-card-attach", code, tenant_id: args.tenant_id, run_id: args.run_id, meta: { table: card.table, decision_class: card.decision_class } });
  const existing = await d.shown(args.tenant_id, target.thread_id, card.id);
  const origin = await originOf(card, target, d.target, args.tenant_id);
  const done = (already: boolean): AttachResult => ({ shown: true, already, card_id: card.id, table: card.table, what: card.title, ...(card.move_key ? { move_key: card.move_key } : {}) });
  if (existing) {
    const upgrade = !existing.full;
    if (upgrade || args.bringToLatest) {
      try {
        const body = upgrade ? attachedCardBody(card, origin) : args.bringToLatest && origin ? withOrigin(card, existing, origin) : undefined;
        await d.rewrite(args.tenant_id, existing.id, { ...(body ? { body } : {}), ...(args.bringToLatest ? { toTarget: target } : {}) });
      } catch (e) {
        const again = await d.shown(args.tenant_id, target.thread_id, card.id).catch(() => null);
        if (!again?.full) throw e;
        if (args.bringToLatest) await d.rewrite(args.tenant_id, again.id, { ...(origin ? { body: withOrigin(card, again, origin) } : {}), toTarget: target });
      }
    }
    log(upgrade ? "chat_card.upgraded" : args.bringToLatest ? "chat_card.moved_to_latest" : "chat_card.already_shown");
    return done(true);
  }
  try {
    await d.emit({
      agent_run_id: target.run_id,
      agent_slug: target.agent_slug,
      tenant_id: args.tenant_id,
      thread_id: target.thread_id,
      kind: "decision",
      body: attachedCardBody(card, origin),
    });
  } catch (e) {
    const landed = await d.shown(args.tenant_id, target.thread_id, card.id).catch(() => null);
    if (!landed?.full) throw e;
    log("chat_card.already_shown");
    return done(true);
  }
  log("chat_card.shown");
  return done(false);
}

const NOT_A_PLAN = "or(body->step->deliverable->>kind.is.null,body->step->deliverable->>kind.neq.strategy)";

export const OPEN_CARDS_MAX = 15;

export async function listOpenCards(tenant_id: string): Promise<OpenCard[]> {
  const db = tenantClient(asTenantId(tenant_id));
  const now = nowIso();
  const [dec, ch] = await Promise.all([
    db
      .from("decisions")
      .select(DECISION_COLS)
      .eq("tenant_id", tenant_id)
      .eq("status", "proposed")
      .eq("autonomy_at_emit", "approval")
      .or(`snoozed_until.is.null,snoozed_until.lte.${now}`)
      .not("decision_class", "in", GROWTH_PAGE_ONLY_NOT_IN)
      .order("emitted_at", { ascending: false })
      .limit(OPEN_CARDS_MAX),
    db
      .from("channel_actions")
      .select(CHANNEL_COLS)
      .eq("tenant_id", tenant_id)
      .is("exec_status", null)
      .or(
        `and(status.eq.pending,${NOT_A_PLAN}),and(status.eq.snoozed,or(snoozed_until.is.null,snoozed_until.lte.${now}),${NOT_A_PLAN})`,
      )
      .order("proposed_at", { ascending: false })
      .limit(OPEN_CARDS_MAX),
  ]);
  if (dec.error) throw new Error(`decision list failed: ${dec.error.message}`);
  if (ch.error) throw new Error(`channel card list failed: ${ch.error.message}`);
  const cards = [
    ...((dec.data ?? []) as Record<string, unknown>[]).map(decisionCard).filter((c) => !c.growth_page_only && c.waiting),
    ...((ch.data ?? []) as Record<string, unknown>[])
      .filter((r) => str(obj(obj(obj(r.body).step).deliverable).kind) !== "strategy")
      .map(channelCard)
      .filter((c) => c.waiting),
  ];
  cards.sort((a, b) => (Date.parse(b.filed_at ?? "") || 0) - (Date.parse(a.filed_at ?? "") || 0));
  return cards.slice(0, OPEN_CARDS_MAX).map((c) => ({ card_id: c.id, table: c.table, what: c.title, where: c.where, filed_at: c.filed_at, move_key: c.move_key }));
}
