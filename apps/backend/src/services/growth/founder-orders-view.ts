
import { adChangeHeadline, adCardTitle } from "@zavi/shared";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { isTenantHumanApproval } from "@/services/decisions/ads-approval-authority";
import { carriesCapturedPageContext } from "@/services/agents/untrusted-context";
import { firstLine, shortDate } from "./cgo-evidence";

const DAY = 86_400_000;
export const FOUNDER_ORDER_DAYS = 14;
export const FOUNDER_SAID_DAYS = 7;
export const FOUNDER_CARD_LINES = 10;
const CARD_ROWS_MAX = 60;
export const FOUNDER_SAID_MAX = 8;
const SAID_ROWS_MAX = 40;
export const SAID_CHARS = 240;
export const HOME_SAID_MAX = 4;
const HOME_THREADS_MAX = 20;
const HOME_SLUG = "operator";
export const HOME_CHAT_WHERE = "Home chat";
export const REPLYING_TO_CHARS = 200;
export const SHORT_SAID_CHARS = 80;
const SIBLINGS_MAX = 3;
export const FOUNDER_ORDERS_CHAR_BUDGET = 6000;
const AD_CLASS_RE = "^[a-z0-9_]+_ads\\.";

const COULD_NOT_READ = "could not read" as const;
export type CouldNotRead = { status: typeof COULD_NOT_READ; reason: string };
export type FounderSaid = { at: string; where: string; text: string; replying_to?: string };
export type FounderOrdersView = {
  cards: string[] | CouldNotRead;
  cards_more?: number;
  said: FounderSaid[] | CouldNotRead;
  home_chat?: CouldNotRead;
};

const FOUNDER_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);
const FOUNDER_ORIGINS: ReadonlySet<string> = new Set(["user_initiated_chat", "user_initiated_ledger"]);

export type FounderCardRow = {
  id: string;
  rail: "decisions" | "channel_actions";
  cls: string;
  change: Record<string, unknown> | null;
  origin?: string | null;
  founder_chat_order?: boolean;
  move_group?: string | null;
  title?: string | null;
  status: string;
  exec_status?: string | null;
  at: string;
  approved_by?: string | null;
  approved_by_source?: string | null;
  rejected_by?: string | null;
  cgo_hold?: { words?: unknown } | null;
  run_id?: string | null;
};

export function cleanSaid(s: unknown, max: number): string {
  const t = typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[<>]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (t.length <= max) return t;
  const head = t.slice(0, max - 1);
  const sp = head.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? head.slice(0, sp) : head).replace(/[\s,;:.\-]+$/, "")}…`;
}

type Link = "ordered_chat" | "chat" | "decided";
const STAMPED_CLASS = /^(meta_ads|google_ads)\./;

export type Founders = ReadonlySet<string>;

export function founderLink(r: FounderCardRow, founderRun: boolean, founders: Founders): Link | null {
  if (r.founder_chat_order === true && STAMPED_CLASS.test(r.cls) && founderRun) return "ordered_chat";
  if (founderRun) return "chat";
  if (founderApproved(r, founders) || founderRejected(r, founders)) return "decided";
  return null;
}

function founderApproved(r: FounderCardRow, founders: Founders): boolean {
  return isTenantHumanApproval(r) && founders.has(r.approved_by as string);
}

function founderRejected(r: FounderCardRow, founders: Founders): boolean {
  return typeof r.rejected_by === "string" && r.rejected_by !== "" && (r.approved_by_source ?? null) === null && founders.has(r.rejected_by);
}

const LINK_WORDS: Record<Link, string> = {
  ordered_chat: "the founder ordered it in chat",
  chat: "filed from the founder's chat",
  decided: "proposed by Zavi",
};

function approver(r: FounderCardRow, founders: Founders): string {
  if (founderApproved(r, founders)) return "the founder approved it";
  if (isTenantHumanApproval(r)) return "a teammate approved it";
  if (r.approved_by_source === "cgo") return "Autopilot (you) approved it";
  if (r.approved_by_source === "staff") return "Zavi staff approved it";
  return "it was approved";
}

function holdWords(r: FounderCardRow): string[] {
  return Array.isArray(r.cgo_hold?.words) ? (r.cgo_hold!.words as unknown[]).filter((w): w is string => typeof w === "string" && w.trim().length > 0) : [];
}

export function isOpen(r: FounderCardRow): boolean {
  return r.rail === "decisions" ? r.status === "proposed" : r.status === "pending" && (r.exec_status == null || r.exec_status === "failed");
}

export function cardState(r: FounderCardRow, founders: Founders = new Set()): string {
  const approver_ = (x: FounderCardRow) => approver(x, founders);
  if (isOpen(r)) {
    const words = holdWords(r);
    const failedOnce = r.rail === "channel_actions" && r.exec_status === "failed" ? "; its last attempt failed" : "";
    return words.length
      ? `waiting for the founder's tap; the checks held it: ${cleanSaid(words.join("; "), 160)}${failedOnce}`
      : `waiting for the founder's tap${failedOnce}`;
  }
  if (r.rail === "channel_actions") {
    if (r.status === "pending") return `${approver_(r)}, being applied`;
    if (r.status === "acted") return r.exec_status === "failed" ? `${approver_(r)}, but the change failed` : `${approver_(r)}, applied`;
    if (r.status === "rejected") return founderRejected(r, founders) ? "the founder rejected it" : "rejected";
    if (r.status === "stale" || r.status === "displaced") return "closed with no decision";
    return r.status;
  }
  switch (r.status) {
    case "approved":
    case "dispatching":
      return `${approver_(r)}, not applied yet`;
    case "acted":
      return `${approver_(r)}, applied`;
    case "dispatch_failed":
      return `${approver_(r)}, but the change failed`;
    case "rejected":
      return founderRejected(r, founders) ? "the founder rejected it" : "rejected";
    case "expired":
      return "expired with no decision";
    default:
      return r.status;
  }
}

function titleOf(r: FounderCardRow): string {
  const t = r.rail === "channel_actions" ? adCardTitle({ title: r.title ?? null, exec_class: r.cls, exec_payload: r.change }) : adChangeHeadline(r.cls, r.change) ?? r.title ?? r.cls;
  return firstLine(t || r.cls, 110);
}

export function founderCardLines(rows: readonly FounderCardRow[], founderRuns: ReadonlySet<string>, founders: Founders = new Set()): { lines: string[]; more: number } {
  const seen = new Set<string>();
  const kept = rows
    .filter((r) => (seen.has(`${r.rail}:${r.id}`) ? false : (seen.add(`${r.rail}:${r.id}`), true)))
    .map((r) => ({ r, link: founderLink(r, !!r.run_id && founderRuns.has(r.run_id), founders) }))
    .filter((x): x is { r: FounderCardRow; link: Link } => x.link !== null);
  const groupOf = (r: FounderCardRow, link: Link) =>
    r.move_group && link === "ordered_chat" ? `g:${r.move_group}` : link !== "decided" && r.run_id ? `r:${r.run_id}` : `id:${r.id}`;
  const byGroup = new Map<string, string[]>();
  for (const { r, link } of kept) byGroup.set(groupOf(r, link), [...(byGroup.get(groupOf(r, link)) ?? []), r.id]);
  kept.sort((a, b) => {
    const ao = isOpen(a.r) ? 0 : 1;
    const bo = isOpen(b.r) ? 0 : 1;
    return ao !== bo ? ao - bo : b.r.at.localeCompare(a.r.at);
  });
  const lines = kept.slice(0, FOUNDER_CARD_LINES).map(({ r, link }) => {
    const others = (byGroup.get(groupOf(r, link)) ?? []).filter((id) => id !== r.id);
    const shown = others.slice(0, SIBLINGS_MAX);
    const pair = shown.length ? `; same order as [${shown.join("], [")}]${others.length > shown.length ? ` and ${others.length - shown.length} more` : ""}` : "";
    return `[${r.id}] ${shortDate(r.at)} ${titleOf(r)} (${LINK_WORDS[link]}) -> ${cardState(r, founders)}${pair}`;
  });
  return { lines, more: Math.max(0, kept.length - FOUNDER_CARD_LINES) };
}

export function budgetFounderOrders(v: FounderOrdersView, max = FOUNDER_ORDERS_CHAR_BUDGET, home: ReadonlySet<number> = new Set()): FounderOrdersView {
  const out: FounderOrdersView = JSON.parse(JSON.stringify(v));
  const size = () => JSON.stringify(out).length;
  const from = Array.isArray(out.said) ? out.said.map((_, i) => i) : [];
  while (size() > max && Array.isArray(out.said) && out.said.length > 0) {
    let at = out.said.length - 1;
    for (let i = from.length - 1; i >= 0; i--) if (home.has(from[i])) { at = i; break; }
    out.said.splice(at, 1);
    from.splice(at, 1);
  }
  while (size() > max && Array.isArray(out.cards) && out.cards.length > 1) {
    out.cards.pop();
    out.cards_more = (out.cards_more ?? 0) + 1;
  }
  return out;
}

type Db = ReturnType<typeof tenantClient>;
const must = <T>(r: { data: unknown; error: { message: string } | null }, what: string): T[] => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return (r.data ?? []) as T[];
};
const failed = (e: unknown): CouldNotRead => ({ status: COULD_NOT_READ, reason: cleanSaid((e as Error)?.message ?? String(e), 120) });
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export type FounderOrderDeps = {
  roleOf: (user_id: string, tenant_id: string) => Promise<string | null>;
  foundersOf: (tenant_id: string) => Promise<string[]>;
};

type RunRow = { id: string; trigger: string | null; enqueued_by: string | null; pc: unknown; origin: string | null };

async function founderChatRuns(db: Db, tenant_id: string, runIds: readonly string[], deps: FounderOrderDeps): Promise<Set<string>> {
  const ids = [...new Set(runIds)];
  if (ids.length === 0) return new Set();
  const runs = must<RunRow>(
    await db.from("agent_runs").select("id, trigger, enqueued_by, pc:payload->page_context, origin:payload->>origin").eq("tenant_id", tenant_id).in("id", ids).limit(ids.length),
    "chat runs",
  );
  const typed = runs.filter((r) => r.trigger === "chat" && !!r.enqueued_by && r.origin !== "staff_console" && !carriesCapturedPageContext({ page_context: r.pc ?? null }));
  const roles = new Map<string, string | null>();
  for (const u of new Set(typed.map((r) => r.enqueued_by as string))) roles.set(u, await deps.roleOf(u, tenant_id));
  return new Set(typed.filter((r) => FOUNDER_ROLES.has(roles.get(r.enqueued_by as string) ?? "")).map((r) => r.id));
}

const DEC_COLS = "id, decision_class, status, body, emitted_at, approved_by, approved_by_source, rejected_by, cgo_hold, agent_run_id";
const CH_COLS = "id, run_id, title, status, exec_status, exec_class, exec_payload, approved_by, approved_by_source, cgo_hold, proposed_at, body_origin:body->>origin, body_order:body->>founder_chat_order, body_group:body->>move_group";

type DecRow = { id: string; decision_class: string; status: string; body: unknown; emitted_at: string; approved_by: string | null; approved_by_source: string | null; rejected_by: string | null; cgo_hold: unknown; agent_run_id: string | null };
type ChRow = { id: string; run_id: string | null; title: string | null; status: string; exec_status: string | null; exec_class: string; exec_payload: unknown; approved_by: string | null; approved_by_source: string | null; cgo_hold: unknown; proposed_at: string; body_origin: string | null; body_order: string | null; body_group: string | null };

function decCard(d: DecRow): FounderCardRow {
  const b = obj(d.body);
  return {
    id: d.id,
    rail: "decisions",
    cls: d.decision_class,
    change: b,
    origin: strOrNull(b?.origin),
    founder_chat_order: b?.founder_chat_order === true,
    move_group: strOrNull(b?.move_group),
    title: strOrNull(b?.title),
    status: d.status,
    at: d.emitted_at,
    approved_by: d.approved_by,
    approved_by_source: d.approved_by_source,
    rejected_by: d.rejected_by,
    cgo_hold: obj(d.cgo_hold),
    run_id: d.agent_run_id,
  };
}

function chCard(c: ChRow): FounderCardRow {
  const p = obj(c.exec_payload);
  return {
    id: c.id,
    rail: "channel_actions",
    cls: c.exec_class,
    change: p,
    origin: strOrNull(p?.origin) ?? c.body_origin,
    founder_chat_order: p?.founder_chat_order === true || c.body_order === "true",
    move_group: strOrNull(p?.move_group) ?? c.body_group,
    title: c.title,
    status: c.status,
    exec_status: c.exec_status,
    at: c.proposed_at,
    approved_by: c.approved_by,
    approved_by_source: c.approved_by_source,
    cgo_hold: obj(c.cgo_hold),
    run_id: c.run_id,
  };
}

async function channelRejecters(db: Db, tenant_id: string, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const ev = must<{ action_id: string; actor_user_id: string | null }>(
    await db.from("channel_action_events").select("action_id, actor_user_id").eq("tenant_id", tenant_id).eq("event", "rejected").eq("actor_kind", "founder").in("action_id", [...ids]).limit(ids.length * 2),
    "channel card rejections",
  );
  return new Map(ev.filter((e) => !!e.actor_user_id).map((e) => [e.action_id, e.actor_user_id as string]));
}

async function foundersAmong(tenant_id: string, users: Iterable<string>, deps: FounderOrderDeps): Promise<Set<string>> {
  const out = new Set<string>();
  for (const u of new Set(users)) if (FOUNDER_ROLES.has((await deps.roleOf(u, tenant_id)) ?? "")) out.add(u);
  return out;
}

async function readCardRows(db: Db, tenant_id: string, now: Date): Promise<FounderCardRow[]> {
  const since = new Date(now.getTime() - FOUNDER_ORDER_DAYS * DAY).toISOString();
  const decisions = () => db.from("decisions").select(DEC_COLS).eq("tenant_id", tenant_id).filter("decision_class", "match", AD_CLASS_RE).gte("emitted_at", since);
  const channel = () => db.from("channel_actions").select(CH_COLS).eq("tenant_id", tenant_id).filter("exec_class", "match", AD_CLASS_RE).gte("proposed_at", since);
  const [openDec, recentDec, openCh, recentCh] = await Promise.all([
    decisions().eq("status", "proposed").order("emitted_at", { ascending: false }).limit(CARD_ROWS_MAX),
    decisions().neq("status", "proposed").order("emitted_at", { ascending: false }).limit(CARD_ROWS_MAX),
    channel().eq("status", "pending").order("proposed_at", { ascending: false }).limit(CARD_ROWS_MAX),
    channel().neq("status", "pending").order("proposed_at", { ascending: false }).limit(CARD_ROWS_MAX),
  ]);
  const ch = [...must<ChRow>(openCh, "open channel ad cards").map(chCard), ...must<ChRow>(recentCh, "decided channel ad cards").map(chCard)];
  const rejecters = await channelRejecters(db, tenant_id, ch.filter((c) => c.status === "rejected").map((c) => c.id));
  return [
    ...must<DecRow>(openDec, "open ad cards").map(decCard),
    ...must<DecRow>(recentDec, "decided ad cards").map(decCard),
    ...ch.map((c) => (rejecters.has(c.id) ? { ...c, rejected_by: rejecters.get(c.id), approved_by_source: c.approved_by_source ?? null } : c)),
  ];
}

type MsgRow = { id: string; thread_id: string; body: string | null; created_at: string; agent_run_id: string | null };
type ThreadRow = { id: string; agent_slug: string | null; channel_slug: string | null; deleted_at: string | null; synthetic: boolean | null };

function whereOf(t: ThreadRow): string {
  if (t.channel_slug) return `${t.channel_slug} chat`;
  if (t.agent_slug === "cgo") return "Growth chat";
  return isHomeThread(t) ? HOME_CHAT_WHERE : `${t.agent_slug ?? "an agent"} chat`;
}

function isHomeThread(t: ThreadRow): boolean {
  return t.agent_slug === HOME_SLUG && !t.channel_slug;
}

const PLEASANTRIES: ReadonlySet<string> = new Set([
  "hi", "hey", "hello", "hiya", "yo", "hi there", "hey there", "hello there", "hi zavi", "hey zavi", "hello zavi",
  "thanks", "thank you", "thanks a lot", "thank you so much", "thanks zavi", "thank you zavi", "thx", "ty",
  "good morning", "good afternoon", "good evening", "gm", "bye", "cheers", "ok thanks", "okay thanks", "great thanks",
]);

export function isPleasantry(text: string): boolean {
  const k = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return k === "" || PLEASANTRIES.has(k);
}

const THREAD_COLS = "id, agent_slug, channel_slug, deleted_at, synthetic";
const MSG_COLS = "id, thread_id, body, created_at, agent_run_id";
const GROWTH_THREADS_MAX = 40;
const CARD_RUNS_MAX = 100;

const newestFirst = (a: MsgRow, b: MsgRow) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);

type SaidRead = { said: FounderSaid[]; home: ReadonlySet<number>; home_unread?: CouldNotRead };

async function readSaid(db: Db, tenant_id: string, now: Date, cardRuns: ReadonlySet<string>, deps: FounderOrderDeps): Promise<SaidRead> {
  const since = new Date(now.getTime() - FOUNDER_SAID_DAYS * DAY).toISOString();
  const founderIds = await deps.foundersOf(tenant_id);
  const founderThreads = () =>
    db
      .from("agent_threads")
      .select(THREAD_COLS)
      .eq("tenant_id", tenant_id)
      .in("user_id", founderIds)
      .eq("synthetic", false)
      .is("deleted_at", null)
      .gte("last_message_at", since);
  const messages = () => db.from("agent_thread_messages").select(MSG_COLS).eq("tenant_id", tenant_id).eq("sender_role", "user").eq("source", "chat").gte("created_at", since);
  const inThreads = async (ids: readonly string[], what: string): Promise<MsgRow[]> =>
    ids.length === 0 ? [] : must<MsgRow>(await messages().in("thread_id", [...ids]).order("created_at", { ascending: false }).limit(SAID_ROWS_MAX), what);

  const threads = new Map<string, ThreadRow>();
  const readGrowth = async (): Promise<MsgRow[]> => {
    if (founderIds.length === 0) return [];
    const ts = must<ThreadRow>(
      await founderThreads().or("agent_slug.eq.cgo,channel_slug.not.is.null").order("last_message_at", { ascending: false }).limit(GROWTH_THREADS_MAX),
      "founder threads",
    );
    for (const t of ts) threads.set(t.id, t);
    return inThreads(ts.map((t) => t.id), "founder messages");
  };
  const readCardWords = async (): Promise<MsgRow[]> => {
    const runs = [...cardRuns].slice(0, CARD_RUNS_MAX);
    return runs.length === 0 ? [] : must<MsgRow>(await messages().in("agent_run_id", runs).order("created_at", { ascending: false }).limit(SAID_ROWS_MAX), "card chat messages");
  };
  const readHome = async (): Promise<MsgRow[]> => {
    if (founderIds.length === 0) return [];
    const ts = must<ThreadRow>(
      await founderThreads().eq("agent_slug", HOME_SLUG).is("channel_slug", null).order("last_message_at", { ascending: false }).limit(HOME_THREADS_MAX),
      "home chat threads",
    );
    for (const t of ts) threads.set(t.id, t);
    return inThreads(ts.map((t) => t.id), "home chat messages");
  };

  const [growthRows, cardRows, homeRead] = await Promise.all([
    readGrowth(),
    readCardWords(),
    readHome().then(
      (rows) => ({ rows }),
      (e: unknown) => ({ rows: [] as MsgRow[], failed: failed(e) }),
    ),
  ]);
  if ("failed" in homeRead) console.warn(JSON.stringify({ evt: "founder_orders.home_chat_unread", tenant_id, reason: homeRead.failed.reason }));
  const usable = (m: MsgRow) => !!m.agent_run_id && cleanSaid(m.body, SAID_CHARS).length > 0;
  const seen = new Set<string>();
  const once = (m: MsgRow) => (seen.has(m.id) ? false : (seen.add(m.id), true));
  const growthMsgs = [...growthRows, ...cardRows].filter(usable).filter(once);
  const homeMsgs = homeRead.rows.filter(usable).filter(once);

  const unread = [...new Set(growthMsgs.map((m) => m.thread_id))].filter((id) => !threads.has(id));
  if (unread.length > 0) {
    for (const t of must<ThreadRow>(await db.from("agent_threads").select(THREAD_COLS).eq("tenant_id", tenant_id).in("id", unread).limit(unread.length), "founder threads")) threads.set(t.id, t);
  }
  const live = (m: MsgRow) => {
    const t = threads.get(m.thread_id);
    return !!t && !t.deleted_at && !t.synthetic;
  };
  const growthSide = growthMsgs.filter(live).sort(newestFirst);
  const homeSide = homeMsgs.filter((m) => live(m) && isHomeThread(threads.get(m.thread_id)!) && !isPleasantry(cleanSaid(m.body, SAID_CHARS))).sort(newestFirst);
  if (growthSide.length === 0 && homeSide.length === 0) return { said: [], home: new Set(), ...("failed" in homeRead ? { home_unread: homeRead.failed } : {}) };

  const founder = await founderChatRuns(db, tenant_id, [...growthSide, ...homeSide].map((m) => m.agent_run_id as string), deps);
  const mine = (m: MsgRow) => founder.has(m.agent_run_id as string);
  const homeKept = new Set(homeSide.filter(mine).slice(0, HOME_SAID_MAX).map((m) => m.id));
  const kept = [...growthSide.filter(mine).slice(0, FOUNDER_SAID_MAX), ...homeSide.filter((m) => homeKept.has(m.id))].sort(newestFirst);
  const said = await Promise.all(
    kept.map(async (m): Promise<FounderSaid> => {
      const text = cleanSaid(m.body, SAID_CHARS);
      const out: FounderSaid = { at: m.created_at, where: whereOf(threads.get(m.thread_id)!), text };
      if (text.length >= SHORT_SAID_CHARS) return out;
      const prev = await db
        .from("agent_thread_messages")
        .select("body")
        .eq("tenant_id", tenant_id)
        .eq("thread_id", m.thread_id)
        .eq("sender_role", "assistant")
        .lt("created_at", m.created_at)
        .order("created_at", { ascending: false })
        .limit(1)
        .then(
          (r) => (r.error ? null : ((r.data ?? []) as Array<{ body: string | null }>)[0]),
          () => null,
        );
      const before = cleanSaid(prev?.body, REPLYING_TO_CHARS);
      return before ? { ...out, replying_to: before } : out;
    }),
  );
  const home = new Set(kept.flatMap((m, i) => (homeKept.has(m.id) ? [i] : [])));
  return { said, home, ...("failed" in homeRead ? { home_unread: homeRead.failed } : {}) };
}

async function defaultDeps(): Promise<FounderOrderDeps> {
  const { loadTenantRoleFor } = await import("@/services/auth/tenant-role");
  return {
    roleOf: loadTenantRoleFor,
    foundersOf: async (tenant_id) =>
      must<{ user_id: string }>(
        await tenantClient(asTenantId(tenant_id)).from("tenant_users").select("user_id").eq("tenant_id", tenant_id).in("role", [...FOUNDER_ROLES]).limit(200),
        "owners and admins",
      ).map((r) => r.user_id),
  };
}

export async function readFounderOrders(tenant_id: string, now: Date = new Date(), deps?: FounderOrderDeps): Promise<FounderOrdersView | null> {
  const db = tenantClient(asTenantId(tenant_id));
  const d = deps ?? (await defaultDeps());
  let cards: { lines: string[]; more: number } | CouldNotRead;
  let cardRuns = new Set<string>();
  try {
    const rows = await readCardRows(db, tenant_id, now);
    const founderRuns = await founderChatRuns(db, tenant_id, rows.map((r) => r.run_id).filter((x): x is string => !!x), d);
    const people = rows.flatMap((r) => [r.approved_by, r.rejected_by]).filter((x): x is string => typeof x === "string" && x !== "");
    const founders = await foundersAmong(tenant_id, people, d);
    cards = founderCardLines(rows, founderRuns, founders);
    cardRuns = new Set(rows.filter((r) => founderLink(r, !!r.run_id && founderRuns.has(r.run_id), founders) !== null && r.run_id).map((r) => r.run_id as string));
  } catch (e) {
    cards = failed(e);
  }
  const read = await readSaid(db, tenant_id, now, cardRuns, d).catch(failed);
  const said = "status" in read ? read : read.said;
  const homeUnread = "status" in read ? undefined : read.home_unread;
  const noCards = !("status" in cards) && cards.lines.length === 0;
  const noSaid = Array.isArray(said) && said.length === 0 && !homeUnread;
  if (noCards && noSaid) return null;
  return budgetFounderOrders(
    {
      cards: "status" in cards ? cards : cards.lines,
      ...(!("status" in cards) && cards.more > 0 ? { cards_more: cards.more } : {}),
      said,
      ...(homeUnread ? { home_chat: homeUnread } : {}),
    },
    FOUNDER_ORDERS_CHAR_BUDGET,
    "status" in read ? new Set() : read.home,
  );
}
