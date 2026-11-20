
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { CHANNELS, adChangeHeadline } from "@zavi/shared";
import type { FounderReply } from "./goal-owner";
import { noteSections, channelCardNoteItem, cleanTitle, itemText, parseNoteItems, type NoteItem } from "./cgo-note-items";
import { budgetRaiseNeed, monthlyBudgetNow, type BudgetRaiseNeed } from "./ad-budget-shortfall";
import type { ApproveResult } from "@/services/channels/exec-actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const money = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

const YES_PHRASES = [
  "yes", "yep", "yeah", "yup", "ok", "okay", "sure", "approve", "approved", "proceed", "confirm", "confirmed", "lgtm",
  "go ahead", "go for it", "do it", "do that", "please do", "sounds good", "looks good", "ship it", "make it so",
];
const NO_PHRASES = [
  "no", "nope", "not", "don't", "dont", "do not", "never", "stop", "wait", "hold", "cancel", "why", "instead", "unless", "maybe",
  "later", "unsure", "can't", "cant", "cannot", "shouldn't", "won't", "wouldn't", "isn't", "nothing", "none", "neither", "leave",
  "keep", "think", "thinking", "consider", "but", "however", "except", "if", "until", "after", "before", "once", "when", "only",
  "tomorrow", "pause", "reduce", "lower", "cut", "decrease", "less", "half", "revert", "undo", "skip", "ignore", "reject", "decline",
];
const LEAD_IN = new Set(["hi", "hey", "hello", "thanks", "thank", "you", "great", "perfect", "please", "cgo", "zavi", "team", "all", "good", "morning"]);
const FILLER = new Set([
  "and", "please", "thanks", "thank", "thx", "ty", "you", "it", "that", "this", "these", "those", "them", "the", "a", "an", "to", "from",
  "per", "day", "daily", "for", "on", "now", "today", "asap", "go", "ahead", "do", "with", "of", "in", "by", "at", "up", "so", "then",
  "let's", "lets", "we", "i", "all", "both", "card", "cards", "too", "is", "fine", "good", "great", "sounds", "looks", "right", "away",
  "immediately", "agreed", "agree", "cool", "nice",
]);

const NUMBER_WORDS = new Set(
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion dozen double triple quadruple twice thrice half quarter".split(" "),
);

const words = (text: string): string[] => text.toLowerCase().replace(/[’`]/g, "'").match(/[a-z0-9']+/g) ?? [];
function phraseAt(tokens: readonly string[], phrase: string, at: number): boolean {
  const p = phrase.split(" ");
  return at + p.length <= tokens.length && p.every((w, k) => tokens[at + k] === w);
}
function hasPhrase(tokens: readonly string[], phrase: string): boolean {
  for (let i = 0; i < tokens.length; i++) if (phraseAt(tokens, phrase, i)) return true;
  return false;
}

export function replySaysYes(text: string, cardWords = ""): boolean {
  if (typeof text !== "string") return false;
  const norm = text.normalize("NFKC");
  if (/[?¿]/.test(norm) || /[^\x00-\x7F’`“”‘–—…]/.test(norm)) return false;
  if (/[<>=~^*|\\]/.test(norm) || /(?:^|[\s,(:;])[-+–—]\s?\$?\d/.test(norm)) return false;
  const t = words(norm);
  if (t.length === 0 || t.length > 40) return false;
  if (NO_PHRASES.some((p) => hasPhrase(t, p)) || t.some((w) => /n't$/.test(w) || /^(didnt|doesnt|isnt|arent|wasnt|wont|wouldnt|shouldnt|couldnt|havent|hasnt|aint)$/.test(w))) return false;
  if (t.some((w) => NUMBER_WORDS.has(w))) return false;
  let at = 0;
  while (at < t.length && at < 4 && LEAD_IN.has(t[at])) at++;
  const yes = YES_PHRASES.find((p) => phraseAt(t, p, at));
  if (!yes) return false;
  const known = new Set([...FILLER, ...YES_PHRASES.flatMap((p) => p.split(" ")), ...words(cardWords.normalize("NFKC"))]);
  return t.slice(at + yes.split(" ").length).every((w) => known.has(w) || /^\d+$/.test(w));
}

export function amountsIn(text: string, opts: { dollarsOnly?: boolean } = {}): string[] {
  const out: string[] = [];
  const re = /(\$\s?)?(\d[\d,]*(?:\.\d+)?)([a-z%]+)?(?:\s?(%)|\s(k|m|mm|mil|mn|bn|bil|b|x|times|percent|pct|thousand|million|billion|hundred|grand|lakh|crore)(?![a-z]))?/gi;
  for (const m of text.normalize("NFKC").matchAll(re)) {
    if (opts.dollarsOnly && !m[1]) continue;
    const n = Number(m[2].replace(/,/g, ""));
    const unit = `${m[3] ?? ""}${m[4] ?? ""}${m[5] ?? ""}`.toLowerCase();
    out.push(`${Number.isFinite(n) ? n : m[2]}${unit}`);
  }
  return out;
}

function moneyValues(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || v === null || typeof v !== "object") return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === "number" && Number.isFinite(x) && /usd|budget|amount|bid|spend|cost|price|cap/i.test(k)) out.push(String(x));
    else if (x && typeof x === "object") moneyValues(x, out, depth + 1);
  }
  return out;
}

export function cardAmounts(exec_class: string | null, exec_payload: unknown): string[] {
  const cls = (exec_class ?? "").replace(/_review$/, "");
  if (cls === "google_ads.update_campaign_budget" || cls === "meta_ads.update_ad_set_budget") {
    const p = (exec_payload ?? {}) as { daily_budget_usd?: unknown; expected_current_daily_budget_usd?: unknown };
    if (typeof p.daily_budget_usd !== "number" || typeof p.expected_current_daily_budget_usd !== "number") return ["unreadable"];
    return [String(p.daily_budget_usd), String(p.expected_current_daily_budget_usd)];
  }
  return moneyValues(exec_payload);
}

export function replyMatchesCard(reply: string, shownLine: string, exec_class: string | null, exec_payload: unknown, shownReason = ""): boolean {
  const card = cardAmounts(exec_class, exec_payload);
  if (card.includes("unreadable")) return false;
  const said = amountsIn(reply);
  if (!isBudgetClass(exec_class) && said.length > 0) return false;
  if (!said.every((n) => card.includes(n))) return false;
  const shown = amountsIn(shownLine, { dollarsOnly: true });
  if (isBudgetClass(exec_class)) {
    const [to, from] = card;
    const ordered = (a: readonly string[]) => a.length === 0 || (a.length === 1 && a[0] === to) || (a.length === 2 && a[0] === from && a[1] === to);
    if (!ordered(said)) return false;
    if (!ordered(shown)) return false;
  } else if (!shown.every((n) => card.includes(n))) return false;
  return statedTargets(shownReason).every((n) => card.includes(n));
}

const isBudgetClass = (exec_class: string | null) => ["google_ads.update_campaign_budget", "meta_ads.update_ad_set_budget"].includes((exec_class ?? "").replace(/_review$/, ""));

export function statedTargets(text: string): string[] {
  const t = text.normalize("NFKC");
  const out: string[] = [];
  const n = "(\\d[\\d,]*(?:\\.\\d+)?)";
  const usd = `\\$\\s?${n}`;
  const any = `\\$?\\s?${n}`;
  const patterns = [
    new RegExp(`${usd}\\s*(?:\\/|per|a|each)\\s*day`, "gi"),
    new RegExp(`(?:budget|spend)\\D{0,24}?${any}\\s*(?:\\/|per|a|each)\\s*day`, "gi"),
    new RegExp(`${usd}\\s*daily`, "gi"),
    new RegExp(`(?:budget|spend)\\s+(?:to|at|of)\\s+${any}`, "gi"),
    new RegExp(`(?:it|them)\\s+(?:to|at)\\s+${usd}`, "gi"),
    new RegExp(`\\bto\\s+${usd}`, "gi"),
  ];
  for (const re of patterns) {
    for (const m of t.matchAll(re)) {
      const n = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(n)) out.push(String(n));
    }
  }
  return out;
}

const STOP = new Set([
  "the", "and", "for", "with", "from", "that", "this", "your", "you", "raise", "budget", "daily", "campaign", "campaigns", "card",
  "ahead", "please", "approve", "approved", "increase", "google", "meta", "youtube", "ads", "into", "about", "more", "spend", "day",
  "over", "have", "will", "what", "when", "them", "then", "than", "also", "just", "does", "each",
]);
const keyWords = (s: string) => new Set(words(s).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)));

export type ReplyCard = { action_id: string; words: string };

export function replyPointsAt(text: string, card: ReplyCard, all: readonly ReplyCard[], opts: { mustName?: boolean } = {}): boolean {
  const reply = words(text);
  const others = all.filter((c) => c.action_id !== card.action_id);
  if (others.length === 0 && !opts.mustName) return true;
  if (others.length > 0 && ["all", "both", "everything"].some((w) => reply.includes(w))) return true;
  const shared = new Set(others.flatMap((c) => [...keyWords(c.words)]));
  const own = [...keyWords(card.words)].filter((w) => !shared.has(w));
  return own.some((w) => reply.includes(w));
}

export type CardRow = {
  id: string;
  run_id: string | null;
  channel_slug: string;
  title: string;
  exec_class: string | null;
  exec_payload: unknown;
  proposed_at?: string | null;
};

export type Fact =
  | { kind: "approved"; id: string; text: string; raised_to: number | null }
  | { kind: "reask"; id: string; text: string; from_usd: number; to_usd: number }
  | { kind: "which"; id: string; text: string }
  | { kind: "left"; id: string; text: string; reason: string; raised_to: number | null };

export type ReplyApprovals = {
  handled: Set<string>;
  items: NoteItem[];
  changed: string[];
  ad_changed: boolean;
  unfulfilled: boolean;
  withhold: (action_id: string) => boolean;
  settleAndAnswer: () => Promise<void>;
};

const result = (withhold: ReplyApprovals["withhold"]): ReplyApprovals => ({ handled: new Set(), items: [], changed: [], ad_changed: false, unfulfilled: false, withhold, settleAndAnswer: async () => undefined });
const NOT_A_REPLY = () => result(() => false);
const NO_APPROVALS = () => result(() => true);

type NoteRow = { id: string; items: unknown; created_at: string };
type ReplyRun = { trigger: string | null; payload: unknown };

export type ReplyApprovalDeps = {
  readReplyRun?: (tenant_id: string, run_id: string) => Promise<ReplyRun | null>;
  verifyFounder?: (args: { tenant_id: string; run_id: string; trigger: string | null; payload: unknown }) => Promise<FounderReply | null>;
  readNote?: (tenant_id: string, run: ReplyRun) => Promise<NoteRow | null>;
  readReasks?: (tenant_id: string, run: ReplyRun, since: string) => Promise<NoteItem[][]>;
  readCard?: (tenant_id: string, action_id: string) => Promise<CardRow | null>;
  ownerId?: (tenant_id: string) => Promise<string | null>;
  budgetNeed?: (tenant_id: string, card: { exec_class: string | null; exec_payload: unknown }) => Promise<BudgetRaiseNeed>;
  raiseBudget?: (tenant_id: string, a: { actor: string; budget_id: string; monthly_usd: number; daily_limit_usd: number | null }) => Promise<boolean>;
  approve?: (tenant_id: string, a: { actionId: string; eventKey: string; actorUserId: string }) => Promise<ApproveResult>;
  sendApproved?: (action_id: string, attempt: number) => Promise<void>;
  readExec?: (tenant_id: string, ids: string[]) => Promise<Array<{ id: string; exec_status: string | null; exec_result: unknown }>>;
  postThread?: (a: { tenant_id: string; channel_id: string; thread_ts: string; team_id: string | null; body: string; key: string }) => Promise<void>;
  log?: (tenant_id: string, meta: Record<string, unknown>) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  settleMs?: number;
};

const channelName = (slug: string) => CHANNELS.find((c) => c.slug === slug)?.name ?? slug;

export async function applyFounderReplyApprovals(
  args: {
    tenant_id: string;
    payload: unknown;
    wanted: ReadonlyArray<{ action_id: string; decision: string; action?: unknown; why?: unknown; usd_at_stake?: number | null }>;
  },
  deps: ReplyApprovalDeps = {},
): Promise<ReplyApprovals> {
  const p = (args.payload ?? {}) as { reason?: unknown; founder_reply?: { reply_run_id?: unknown } | null };
  const reply_run_id = p.reason === "founder_reply" && typeof p.founder_reply?.reply_run_id === "string" ? p.founder_reply.reply_run_id : "";
  if (!UUID.test(reply_run_id)) return NOT_A_REPLY();
  const tenant_id = args.tenant_id;
  try {
    const run = await (deps.readReplyRun ?? readReplyRun)(tenant_id, reply_run_id);
    if (!run) return NO_APPROVALS();
    const reply = await (deps.verifyFounder ?? verifyFounder)({ tenant_id, run_id: reply_run_id, trigger: run.trigger, payload: run.payload });
    if (!reply || (reply.via !== "slack" && reply.via !== "email")) return NO_APPROVALS();

    const note = await (deps.readNote ?? readRepliedNote)(tenant_id, run);
    const noteItems = note ? parseNoteItems(note.items) : null;
    if (!note || !noteItems) return NO_APPROVALS();
    const shownRows = noteSections(noteItems, { wouldChange: [], link: () => null, moreUrl: "" }).find((sec) => sec.key === "needs_you")?.rows ?? [];
    const listed = shownRows.flatMap((r) => (r.item?.action_id && !r.fold ? [r.item] : []));
    if (listed.length === 0) return NO_APPROVALS();
    const grouped = shownRows.flatMap((r) => (r.group?.items ?? r.fold?.items ?? []).filter((i) => i.action_id));
    if (!replySaysYes(reply.text, listed.map((i) => `${i.text} ${i.card_change ?? ""}`).join(" "))) return NO_APPROVALS();
    const mustName = noteItems.some((i) => i.question_ordinal != null) || grouped.length > 0;
    const cards: ReplyCard[] = [...listed, ...grouped].map((i) => ({ action_id: i.action_id!, words: `${i.text} ${i.reason ?? ""}` }));
    const listedIds = new Set(listed.map((i) => i.action_id!));
    const itemOf = (id: string) => listed.find((i) => i.action_id === id);

    const picked = new Map(args.wanted.filter((c) => c.decision === "approve" && listedIds.has(c.action_id)).map((c) => [c.action_id, c]));
    if (listed.length === 1 && !mustName && !picked.has(listed[0].action_id!)) picked.set(listed[0].action_id!, { action_id: listed[0].action_id!, decision: "approve" });
    const withheldIds = new Set([...listedIds, ...grouped.map((i) => i.action_id!)]);
    const listedOnly = (id: string) => withheldIds.has(id);
    if (picked.size === 0) return result(listedOnly);

    const reasks = await (deps.readReasks ?? readReasksInConversation)(tenant_id, run, note.created_at);
    const statedFor = (id: string): number | null => {
      for (const items of [...reasks, listed]) {
        const hit = items.find((i) => i.action_id === id && typeof i.budget_to_usd === "number");
        if (hit) return hit.budget_to_usd!;
      }
      return null;
    };

    const owner = await (deps.ownerId ?? ownerId)(tenant_id);
    if (!owner) return NO_APPROVALS();

    const out: ReplyApprovals = result(listedOnly);
    const facts: Fact[] = [];
    const { CGO_AD_CHANNELS } = await import("./cgo-ads");
    const { isExecutableAdClass } = await import("./unattended-policy");
    const { execPlatformLabel } = await import("@/services/channels/exec-kill-switch");

    for (const [action_id, c] of picked) {
      const row = await (deps.readCard ?? readCard)(tenant_id, action_id);
      if (!row || !row.exec_class || !isExecutableAdClass(row.exec_class) || !CGO_AD_CHANNELS.has(row.channel_slug)) continue;
      const listedItem = itemOf(action_id);
      if (!listedItem) continue;
      const text = listedItem.text || itemText(c.action, row.title);
      const platform = execPlatformLabel(row.exec_class);
      const base = { row, bucket: null, action: text, usd: c.usd_at_stake ?? listedItem?.usd_at_stake ?? null, platform, fixText: null } as const;
      const leave = (reason: string, raised_to: number | null = null, extra: Partial<NoteItem> = {}) => {
        out.handled.add(action_id);
        out.unfulfilled = true;
        out.items.push({ ...channelCardNoteItem({ ...base, outcome: "leave", why: reason }), ...extra });
        return raised_to;
      };

      const card = cards.find((k) => k.action_id === action_id) ?? { action_id, words: `${text} ${row.title}` };
      const { cardChangeSentence } = await import("./card-change");
      const doesNow = cardChangeSentence(row.exec_class, row.exec_payload);
      if (!listedItem.card_change || doesNow === null || doesNow !== listedItem.card_change) {
        leave("This card is not exactly what my note described any more, so I changed nothing. Tap Approve on the card to run it as it is now");
        facts.push({ kind: "left", id: action_id, text, reason: "the card is not exactly what my note described any more; tap Approve on the card to run it as it is now", raised_to: null });
        continue;
      }
      if (!replySaysYes(reply.text, `${listedItem.text} ${listedItem.card_change}`)) {
        leave("Your reply did not read as a plain yes to this one, so I changed nothing. Reply yes with its name and I will run it");
        facts.push({ kind: "which", id: action_id, text });
        continue;
      }
      if (!replyMatchesCard(reply.text, listedItem.text, row.exec_class, row.exec_payload, listedItem.reason ?? "")) {
        leave("Your reply and this card do not name the same amounts, so I changed nothing. Tell me the amount you want");
        facts.push({ kind: "left", id: action_id, text, reason: "your reply and the card do not name the same amounts, so nothing changed", raised_to: null });
        continue;
      }
      if (!replyPointsAt(reply.text, card, cards, { mustName })) {
        leave("Your reply did not say which one. Reply with its name and I will run it");
        facts.push({ kind: "which", id: action_id, text });
        continue;
      }

      const need = await (deps.budgetNeed ?? budgetRaiseNeed)(tenant_id, row);
      let raised_to: number | null = null;
      if (need.kind === "unreadable") {
        leave("I could not read your ad budget just now, so I changed nothing. Reply yes again in a few minutes");
        facts.push({ kind: "left", id: action_id, text, reason: "I could not read your ad budget just now, so nothing changed", raised_to: null });
        continue;
      }
      if (need.kind === "unfixable") {
        const why = need.why === "over_daily_limit" ? "it would go over your daily ad limit" : "your ad budget runs on USD ad accounts only";
        leave(`${why[0].toUpperCase()}${why.slice(1)}, so I changed nothing`);
        facts.push({ kind: "left", id: action_id, text, reason: `${why}, so nothing changed`, raised_to: null });
        continue;
      }
      if (need.kind === "needs_raise") {
        const stated = statedFor(action_id);
        if (stated === null || stated < need.to_usd) {
          leave("It needs more monthly ad budget than is left", null, { budget_from_usd: need.from_usd, budget_to_usd: need.to_usd });
          facts.push({ kind: "reask", id: action_id, text, from_usd: need.from_usd, to_usd: need.to_usd });
          continue;
        }
        const ok = await (deps.raiseBudget ?? raiseBudget)(tenant_id, { actor: owner, budget_id: need.budget_id, monthly_usd: stated, daily_limit_usd: need.daily_limit_usd });
        if (!ok) {
          leave("I could not raise your monthly ad budget, so I changed nothing");
          facts.push({ kind: "left", id: action_id, text, reason: "I could not raise your monthly ad budget, so nothing changed", raised_to: null });
          continue;
        }
        raised_to = stated;
      }

      const result = await (deps.approve ?? approve)(tenant_id, { actionId: action_id, eventKey: `cgo-reply:${reply_run_id}:${action_id}`, actorUserId: owner });
      if (!result.ok) {
        const reason = raised_to !== null ? `It could not be approved. ${monthlyBudgetNow(raised_to)}` : "It could not be approved";
        leave(reason);
        facts.push({ kind: "left", id: action_id, text, reason: "it could not be approved", raised_to });
        continue;
      }
      out.handled.add(action_id);
      let mustSend = !result.replayed || result.stillQueued === true;
      if (result.replayed && !mustSend) {
        const now = await (deps.readExec ?? readExec)(tenant_id, [action_id]).catch(() => null);
        mustSend = now === null || now[0]?.exec_status === "queued";
      }
      let sent = !mustSend;
      for (let attempt = 0; attempt < 3 && !sent; attempt++) {
        sent = await (deps.sendApproved ?? sendApproved)(action_id, result.attempt).then(
          () => true,
          () => false,
        );
      }
      if (!sent) {
        const why = "I approved it but could not start it. Tap Approve on the card to start it";
        out.unfulfilled = true;
        out.items.push(channelCardNoteItem({ ...base, outcome: "leave", why: raised_to !== null ? `${why}. ${monthlyBudgetNow(raised_to)}` : why }));
        facts.push({ kind: "left", id: action_id, text, reason: "I approved it but could not start it; tap Approve on the card to start it", raised_to });
        continue;
      }
      if (result.replayed) continue;
      out.ad_changed = true;
      out.changed.push(`Approved the ${channelName(row.channel_slug)} card "${adChangeHeadline(row.exec_class, row.exec_payload) ?? cleanTitle(row.title)}". The founder said yes in their reply.`);
      out.items.push(channelCardNoteItem({ ...base, outcome: "approve_queued", why: raised_to !== null ? monthlyBudgetNow(raised_to) : "You said yes in your reply" }));
      facts.push({ kind: "approved", id: action_id, text, raised_to });
      await (deps.log ?? logApproved)(tenant_id, { decision_class: row.exec_class, surface: reply.via, budget_raised: raised_to !== null }).catch(() => undefined);
    }

    out.settleAndAnswer = async () => {
      try {
        await settleAndAnswer({ tenant_id, reply_run_id, reply, run, facts }, deps);
      } catch (e) {
        console.warn(`[founder-reply-approve] thread answer skipped for ${tenant_id}: ${(e as Error).message}`);
      }
    };
    return out;
  } catch (e) {
    console.warn(`[founder-reply-approve] nothing approved for ${tenant_id}: ${(e as Error).message}`);
    return NO_APPROVALS();
  }
}

export function threadAnswer(facts: readonly Fact[], exec: ReadonlyMap<string, { exec_status: string | null; exec_result: unknown }>): string {
  const lines: string[] = [];
  const text = (t: string) => t.replace(/^(Applying|Applied): /, "").replace(/[.\s]+$/, "");
  for (const f of facts) {
    const t = text(f.text);
    if (f.kind === "reask") {
      lines.push(`${t} needs your monthly ad budget at ${money(f.to_usd)} now (it is ${money(f.from_usd)}). Nothing changed yet. Reply yes to raise it and run this.`);
    } else if (f.kind === "which") {
      lines.push(`I was not sure you meant "${t}". Reply with its name and I will run it.`);
    } else if (f.kind === "left") {
      lines.push(`I did not run "${t}": ${f.reason}.${f.raised_to !== null ? ` ${monthlyBudgetNow(f.raised_to)}.` : ""}`);
    } else {
      const budget = f.raised_to !== null ? ` ${monthlyBudgetNow(f.raised_to)}.` : "";
      const e = exec.get(f.id);
      if (e?.exec_status === "executed") lines.push(`Done: ${t}.${budget}`);
      else if (e?.exec_status === "failed") {
        const short = JSON.stringify(e.exec_result ?? "").includes("ad_budget_over_month");
        lines.push(`I approved "${t}", but it did not run: ${short ? "this month's ad budget is still short" : "the ad platform did not take it"}. It is back on its card.${budget}`);
      } else lines.push(`Approved: ${t}. It is applying now.${budget}`);
    }
  }
  return lines.join("\n");
}

async function settleAndAnswer(
  a: { tenant_id: string; reply_run_id: string; reply: FounderReply; run: ReplyRun; facts: Fact[] },
  deps: ReplyApprovalDeps,
): Promise<void> {
  if (a.facts.length === 0) return;
  const approved = a.facts.filter((f) => f.kind === "approved").map((f) => f.id);
  const exec = new Map<string, { exec_status: string | null; exec_result: unknown }>();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = Date.now() + (deps.settleMs ?? 30_000);
  while (approved.length > 0) {
    const rows = await (deps.readExec ?? readExec)(a.tenant_id, approved).catch(() => []);
    for (const r of rows) exec.set(r.id, r);
    if (approved.every((id) => ["executed", "failed"].includes(exec.get(id)?.exec_status ?? "")) || Date.now() >= until) break;
    await sleep(3000);
  }
  if (a.reply.via !== "slack") return;
  const slack = (a.run.payload as { slack?: { channel_id?: unknown; thread_ts?: unknown; team_id?: unknown } } | null)?.slack;
  if (typeof slack?.channel_id !== "string" || typeof slack.thread_ts !== "string") return;
  await (deps.postThread ?? postThread)({
    tenant_id: a.tenant_id,
    channel_id: slack.channel_id,
    thread_ts: slack.thread_ts,
    team_id: typeof slack.team_id === "string" && slack.team_id ? slack.team_id : null,
    body: threadAnswer(a.facts, exec),
    key: `cgo_reply_result:${a.reply_run_id}`,
  });
}

async function readReplyRun(tenant_id: string, run_id: string): Promise<ReplyRun | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("trigger, payload, agent_slug")
    .eq("id", run_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error) throw new Error(`reply run read failed: ${error.message}`);
  const r = data as { trigger: string | null; payload: unknown; agent_slug: string } | null;
  return r && r.agent_slug === "cgo" ? { trigger: r.trigger, payload: r.payload } : null;
}

async function verifyFounder(a: { tenant_id: string; run_id: string; trigger: string | null; payload: unknown }): Promise<FounderReply | null> {
  const { founderReplyFromRun } = await import("./cgo-reply");
  return founderReplyFromRun(a);
}

const NOTE_KEY = /^(note:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

async function readRepliedNote(tenant_id: string, run: ReplyRun): Promise<NoteRow | null> {
  const db = tenantClient(asTenantId(tenant_id));
  const p = (run.payload ?? {}) as { cgo_reply?: { note_key?: unknown }; email?: { email_message_id?: unknown } };
  let key = typeof p.cgo_reply?.note_key === "string" ? p.cgo_reply.note_key : "";
  if (!key && run.trigger === "email" && typeof p.email?.email_message_id === "string") {
    const { data: msg } = await db.from("email_messages").select("thread_id").eq("id", p.email.email_message_id).eq("tenant_id", tenant_id).maybeSingle();
    const thread_id = (msg as { thread_id?: string } | null)?.thread_id;
    if (!thread_id) return null;
    const { data: thread } = await db.from("email_threads").select("root_message_id").eq("id", thread_id).eq("tenant_id", tenant_id).maybeSingle();
    const root = (thread as { root_message_id?: string | null } | null)?.root_message_id;
    if (!root) return null;
    const { data: sent } = await db
      .from("email_messages")
      .select("headers")
      .eq("tenant_id", tenant_id)
      .eq("thread_id", thread_id)
      .eq("direction", "out")
      .eq("rfc_message_id", root)
      .limit(1)
      .maybeSingle();
    const { CGO_NOTE_HEADER } = await import("@/email/sendAgentOwnedEmail");
    const h = (sent as { headers?: Record<string, unknown> } | null)?.headers?.[CGO_NOTE_HEADER];
    key = typeof h === "string" ? h : "";
  }
  const m = NOTE_KEY.exec(key);
  if (!m) return null;
  const q = db.from("cgo_notes").select("id, items, created_at").eq("tenant_id", tenant_id);
  const { data, error } = await (m[1] ? q.eq("id", m[2]) : q.eq("run_id", m[2])).maybeSingle();
  if (error) throw new Error(`note read failed: ${error.message}`);
  return (data as NoteRow | null) ?? null;
}

async function conversationOf(tenant_id: string, run: ReplyRun): Promise<string | null> {
  const p = (run.payload ?? {}) as { slack?: { channel_id?: unknown; thread_ts?: unknown }; email?: { email_message_id?: unknown } };
  if (run.trigger === "slack") {
    return typeof p.slack?.channel_id === "string" && typeof p.slack.thread_ts === "string" ? `slack:${p.slack.channel_id}:${p.slack.thread_ts}` : null;
  }
  if (run.trigger === "email" && typeof p.email?.email_message_id === "string") {
    const { data } = await tenantClient(asTenantId(tenant_id)).from("email_messages").select("thread_id").eq("id", p.email.email_message_id).eq("tenant_id", tenant_id).maybeSingle();
    const thread_id = (data as { thread_id?: string } | null)?.thread_id;
    return thread_id ? `email:${thread_id}` : null;
  }
  return null;
}

async function readReasksInConversation(tenant_id: string, run: ReplyRun, since: string): Promise<NoteItem[][]> {
  const here = await conversationOf(tenant_id, run);
  if (!here) return [];
  const db = tenantClient(asTenantId(tenant_id));
  const { data, error } = await db.from("cgo_notes").select("items, run_id, created_at").eq("tenant_id", tenant_id).gt("created_at", since).order("created_at", { ascending: false }).limit(10);
  if (error) throw new Error(`later notes read failed: ${error.message}`);
  const out: NoteItem[][] = [];
  for (const n of (data ?? []) as Array<{ items: unknown; run_id: string | null }>) {
    if (!n.run_id || !UUID.test(n.run_id)) continue;
    const { data: review } = await db.from("agent_runs").select("payload").eq("id", n.run_id).eq("tenant_id", tenant_id).maybeSingle();
    const cause = (review as { payload?: { reason?: unknown; founder_reply?: { reply_run_id?: unknown } } } | null)?.payload;
    const earlier = cause?.reason === "founder_reply" && typeof cause.founder_reply?.reply_run_id === "string" ? cause.founder_reply.reply_run_id : "";
    if (!UUID.test(earlier)) continue;
    const replyRun = await readReplyRun(tenant_id, earlier);
    if (!replyRun || (await conversationOf(tenant_id, replyRun)) !== here) continue;
    out.push(parseNoteItems(n.items) ?? []);
  }
  return out;
}

async function readCard(tenant_id: string, action_id: string): Promise<CardRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("channel_actions")
    .select("id, run_id, channel_slug, title, exec_class, exec_payload, proposed_at")
    .eq("id", action_id)
    .eq("tenant_id", tenant_id)
    .eq("status", "pending")
    .maybeSingle();
  if (error) throw new Error(`card read failed: ${error.message}`);
  return (data as CardRow | null) ?? null;
}

async function ownerId(tenant_id: string): Promise<string | null> {
  const { tenantOwnerId } = await import("./cgo-auto-run");
  return tenantOwnerId(tenant_id);
}

async function raiseBudget(tenant_id: string, a: { actor: string; budget_id: string; monthly_usd: number; daily_limit_usd: number | null }): Promise<boolean> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "update_ad_budget", {
    p_actor: a.actor,
    p_budget_id: a.budget_id,
    p_monthly_usd: a.monthly_usd,
    p_daily_limit_usd: a.daily_limit_usd,
  });
  if (error) {
    console.warn(`[founder-reply-approve] budget raise refused for ${tenant_id}: ${error.message}`);
    return false;
  }
  return (data as { status?: string } | null)?.status === "updated";
}

async function approve(tenant_id: string, a: { actionId: string; eventKey: string; actorUserId: string }): Promise<ApproveResult> {
  const { approveChannelAction } = await import("@/services/channels/exec-actions");
  return approveChannelAction(tenant_id, a);
}

async function sendApproved(action_id: string, attempt: number): Promise<void> {
  const { inngest } = await import("@/../workers/client");
  await inngest.send({ id: `approve:${action_id}:${attempt}`, name: "channel-action.approved", data: { action_id } });
}

async function readExec(tenant_id: string, ids: string[]) {
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("channel_actions").select("id, exec_status, exec_result").eq("tenant_id", tenant_id).in("id", ids);
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{ id: string; exec_status: string | null; exec_result: unknown }>;
}

async function postThread(a: { tenant_id: string; channel_id: string; thread_ts: string; team_id: string | null; body: string; key: string }): Promise<void> {
  if (!a.body.trim()) return;
  const { enqueueSlackOutbox } = await import("@/services/slack/outbox");
  await enqueueSlackOutbox({ tenant_id: a.tenant_id, channel_id: a.channel_id, thread_ts: a.thread_ts, kind: "cgo_reply_result", body: a.body, team_id: a.team_id, idempotency_key: a.key });
}

async function logApproved(tenant_id: string, meta: Record<string, unknown>): Promise<void> {
  const { logEvent } = await import("@/services/logging/logEvent");
  await logEvent({ level: "info", source: "cgo-ads", code: "cgo.founder_reply_approved", message: "channel ad action approved by the founder's reply to a cgo note", tenant_id, meta });
}

export async function applyFounderReplyWithoutReview(tenant_id: string, reply_run_id: string, deps: ReplyApprovalDeps = {}): Promise<void> {
  try {
    const out = await applyFounderReplyApprovals({ tenant_id, payload: { reason: "founder_reply", founder_reply: { reply_run_id } }, wanted: [] }, deps);
    if (out.handled.size > 0) {
      await out.settleAndAnswer();
      return;
    }
    const run = await (deps.readReplyRun ?? readReplyRun)(tenant_id, reply_run_id);
    const slack = (run?.payload as { slack?: { channel_id?: unknown; thread_ts?: unknown; team_id?: unknown } } | null)?.slack;
    if (run?.trigger !== "slack" || typeof slack?.channel_id !== "string" || typeof slack.thread_ts !== "string") return;
    await (deps.postThread ?? postThread)({
      tenant_id,
      channel_id: slack.channel_id,
      thread_ts: slack.thread_ts,
      team_id: typeof slack.team_id === "string" && slack.team_id ? slack.team_id : null,
      body: "I did not change anything from your reply: there is no active goal for me to review it under. Tap Approve on the card if you want it to run.",
      key: `cgo_reply_result:${reply_run_id}`,
    });
  } catch (e) {
    console.warn(`[founder-reply-approve] reply without a review skipped for ${tenant_id}: ${(e as Error).message}`);
  }
}
