
import { junkReasonForCandidate } from "./junk-filter";
import { renderUntrustedBlock } from "@/services/agents/prompt-injection";

export type ValueKind = "id" | "money" | "rate" | "other";
export type SourceClass = "user_stated" | "agent_inferred" | "fetched_web" | "connector";
export type GateAction = "add" | "duplicate" | "update" | "reject";

export const VALUE_KINDS: ReadonlySet<ValueKind> = new Set(["id", "money", "rate", "other"]);
export const SOURCE_CLASSES: ReadonlySet<SourceClass> = new Set([
  "user_stated",
  "agent_inferred",
  "fetched_web",
  "connector",
]);
const GATE_ACTIONS: ReadonlySet<GateAction> = new Set(["add", "duplicate", "update", "reject"]);

export type ExistingFact = {
  ref: string;
  note_id: string;
  title: string;
  body: string;
  note_type: string;
  subject: string | null;
  attribute: string | null;
  value_kind: ValueKind | null;
  source_class: SourceClass | null;
  trust_tier: number;
  recalled: boolean;
};

export type GateFields = {
  action: GateAction;
  target: string | null;
  subject: string | null;
  attribute: string | null;
  value_kind: ValueKind;
  source_class: SourceClass;
  reason: string | null;
};

export type GateCandidate = GateFields & { title: string; body: string };

export type GateDecision =
  | { kind: "add"; reason: string | null }
  | { kind: "duplicate"; matched: ExistingFact; reason: string }
  | { kind: "update"; target: ExistingFact }
  | { kind: "conflict"; target: ExistingFact; reason: "protected_value" | "lower_trust" }
  | { kind: "reject"; reason: string; junk: boolean };

export function normalizeKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const k = raw
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return k.length > 0 ? k : null;
}

const MONEY_RE =
  /[$€£₹]\s?\d|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|dollars?|eur|euros?|gbp|inr|rupees?)\b|\b(?:usd|eur|gbp|inr)\s?\d/i;
const RATE_RE = /\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?\s?(?:percent|per cent|bps|basis points)\b/i;
const LABELLED_ID_RE =
  /\b(?:id|ids|pixel|account|acct|key|token|number|no\.?|sku|handle|workspace|property|tag)\b[^.\n]{0,24}?\b[A-Za-z0-9_-]*\d[A-Za-z0-9_-]{4,}\b/i;
const LONG_DIGITS_RE = /\b\d{9,}\b/;
const MIXED_TOKEN_RE = /\b(?=[A-Za-z0-9_-]{10,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]+\b/;

export function detectValueKind(text: string): ValueKind {
  const t = text ?? "";
  if (LABELLED_ID_RE.test(t) || LONG_DIGITS_RE.test(t) || MIXED_TOKEN_RE.test(t)) return "id";
  if (MONEY_RE.test(t)) return "money";
  if (RATE_RE.test(t)) return "rate";
  return "other";
}

export function isProtectedKind(k: ValueKind | null | undefined): boolean {
  return k === "id" || k === "money" || k === "rate";
}

export function sourceClassTier(c: SourceClass): number {
  if (c === "user_stated") return 0;
  if (c === "agent_inferred") return 2;
  return 3;
}

export function finalTrustTier(ceiling: number, sourceClass: SourceClass): number {
  return Math.max(ceiling, sourceClassTier(sourceClass));
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were", "be",
  "it", "its", "our", "we", "they", "their", "this", "that", "with", "as", "at", "by", "from",
  "has", "have", "had", "not", "no", "but", "so", "all", "any", "per",
]);

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of (text ?? "").toLowerCase().split(/[^a-z0-9$%.]+/)) {
    const t = w.replace(/^\.+|\.+$/g, "");
    if (t.length >= 2 && !STOP.has(t)) out.add(t);
  }
  return out;
}

export function jaccard(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

export function valueTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of (text ?? "").matchAll(/[$€£₹]?\d[\d,]*(?:\.\d+)?%?/g)) {
    out.add(m[0].replace(/,/g, "").replace(/^[$€£₹]/, ""));
  }
  for (const m of (text ?? "").matchAll(/\b(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z_-]*\d[A-Za-z0-9_-]*\b/g)) {
    out.add(m[0].toLowerCase());
  }
  return out;
}

function sameValues(a: string, b: string): boolean {
  const A = valueTokens(a);
  const B = valueTokens(b);
  if (A.size !== B.size) return false;
  for (const x of A) if (!B.has(x)) return false;
  return true;
}

const NEAR_VERBATIM = 0.8;

function factText(x: { title: string; body: string }): string {
  return `${x.title}\n${x.body}`;
}

function keysMatch(c: GateCandidate, t: ExistingFact): boolean {
  const cs = normalizeKey(c.subject);
  const ca = normalizeKey(c.attribute);
  const ts = normalizeKey(t.subject);
  const ta = normalizeKey(t.attribute);
  return !!cs && !!ca && cs === ts && ca === ta;
}

function isProtectedPair(c: GateCandidate, t: ExistingFact): boolean {
  return (
    isProtectedKind(c.value_kind) ||
    isProtectedKind(t.value_kind) ||
    isProtectedKind(detectValueKind(factText(c))) ||
    isProtectedKind(detectValueKind(factText(t)))
  );
}

function resolveUpdate(c: GateCandidate, target: ExistingFact, candidateTier: number): GateDecision {
  if (!keysMatch(c, target)) return { kind: "add", reason: "update_key_mismatch" };
  if (sameValues(factText(c), factText(target)) && jaccard(factText(c), factText(target)) >= NEAR_VERBATIM) {
    return { kind: "duplicate", matched: target, reason: "same_key_same_value" };
  }
  if (isProtectedPair(c, target)) return { kind: "conflict", target, reason: "protected_value" };
  if (candidateTier > target.trust_tier) return { kind: "conflict", target, reason: "lower_trust" };
  return { kind: "update", target };
}

export function resolveGateDecision(
  c: GateCandidate,
  existing: ReadonlyMap<string, ExistingFact>,
  candidateTier: number,
): GateDecision {
  const junk = junkReasonForCandidate({ title: c.title, body: c.body });
  if (junk) return { kind: "reject", reason: `junk:${junk}`, junk: true };
  if (c.action === "reject") {
    return { kind: "reject", reason: (c.reason ?? "model_reject").slice(0, 200), junk: false };
  }

  const target = c.target ? existing.get(c.target) : undefined;

  if (c.action === "duplicate" && target) {
    if (!sameValues(factText(c), factText(target))) return resolveUpdate(c, target, candidateTier);
    return { kind: "duplicate", matched: target, reason: (c.reason ?? "model_duplicate").slice(0, 200) };
  }
  if (c.action === "update" && target) return resolveUpdate(c, target, candidateTier);

  const ordered = [...existing.values()].sort((a, b) => Number(b.recalled) - Number(a.recalled));
  for (const e of ordered) {
    if (jaccard(factText(c), factText(e)) >= NEAR_VERBATIM && sameValues(factText(c), factText(e))) {
      return { kind: "duplicate", matched: e, reason: e.recalled ? "restates_recalled_note" : "near_verbatim" };
    }
  }
  const unresolved = (c.action === "duplicate" || c.action === "update") && !target;
  return { kind: "add", reason: unresolved ? `${c.action}_target_unresolved` : null };
}

export function parseGateFields(raw: Record<string, unknown>, text: string): GateFields {
  const action = GATE_ACTIONS.has(raw.action as GateAction) ? (raw.action as GateAction) : "add";
  const target = typeof raw.target === "string" && /^[ER]\d{1,2}$/.test(raw.target.trim())
    ? raw.target.trim()
    : null;
  const modelKind = VALUE_KINDS.has(raw.value_kind as ValueKind) ? (raw.value_kind as ValueKind) : "other";
  const detected = detectValueKind(text);
  const value_kind = isProtectedKind(modelKind) ? modelKind : detected;
  const source_class = SOURCE_CLASSES.has(raw.source as SourceClass)
    ? (raw.source as SourceClass)
    : "agent_inferred";
  return {
    action,
    target,
    subject: normalizeKey(raw.subject),
    attribute: normalizeKey(raw.attribute),
    value_kind,
    source_class,
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 200) : null,
  };
}

export const PROPOSALS_ONLY_NOTE =
  "(This run's own output is not used for memory here. Judge only the agent's memory_write proposals below and emit no other artifacts.)";

export type ProposalForPrompt = { ref: string; title: string; body: string };

export function renderProposalsBlock(proposals: readonly ProposalForPrompt[]): string {
  if (proposals.length === 0) return "";
  const lines = proposals.map((p) => `[${p.ref}] ${p.title ? `${p.title}: ` : ""}${p.body}`);
  return [
    "## Facts the agent asked to save (memory_write)",
    'These come from the agent, not the user. Judge each one against the saved memory below exactly like any other fact, and return EXACTLY ONE artifact per proposal with "proposal_ref" set to its P ref: "add", "duplicate", "update", or "reject" (not durable, the agent\'s own plan or advice, a guess). Its "source" is "agent_inferred" unless this turn\'s user message states the fact. For a proposal you add or update, "body_markdown" keeps every fact you accept from it, as a list if there are many (the 1-3 sentence limit does not apply).',
    renderUntrustedBlock("agent_memory_proposals", lines.join("\n\n")),
  ].join("\n");
}

const EXCERPT_CHARS = 400;

export function renderSavedMemoryBlock(facts: readonly ExistingFact[]): string {
  if (facts.length === 0) {
    return "## Saved memory closest to this turn\n(none: nothing saved yet is close to this turn)";
  }
  const lines = facts.map((f) => {
    const keys = [
      f.subject ? `subject="${f.subject}"` : null,
      f.attribute ? `attribute="${f.attribute}"` : null,
      f.value_kind ? `value_kind=${f.value_kind}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const tag = f.recalled ? " (recalled into this turn)" : "";
    const body = f.body.replace(/\s+/g, " ").slice(0, EXCERPT_CHARS);
    return `[${f.ref}]${tag} ${f.note_type}${keys ? ` · ${keys}` : ""}\n${f.title}: ${body}`;
  });
  return [
    "## Saved memory closest to this turn",
    renderUntrustedBlock("saved_memory", lines.join("\n\n")),
  ].join("\n");
}

export function writeGateRules(opts: { agentProcedural: boolean }): string {
  return WRITE_GATE_RULES_TEMPLATE.replace(
    "__AGENT_PROCEDURAL__",
    opts.agentProcedural ? ' | "agent_procedural"' : "",
  ).replace("__USER_QUOTE__", opts.agentProcedural ? USER_QUOTE_FIELD : "");
}

const USER_QUOTE_FIELD = `
  "user_quote": "agent_procedural only: the operator's exact words from THIS turn's user message that state the rule, copied verbatim. The operator's own sentence containing the quote is saved as the rule, so quote the whole instruction. No quote, no agent_procedural.",`;

const WRITE_GATE_RULES_TEMPLATE = `CHECK EVERY FACT AGAINST SAVED MEMORY. The input ends with the saved notes closest to this turn ([E1], [E2], ...) and the notes recalled into this turn ([R1], ...). For each fact choose one action:
- "add": no saved note holds this information.
- "duplicate": a saved note already says this, in any wording. Set "target" to its ref. A fact the reply restated from an [R] note is ALWAYS a duplicate: the agent was repeating memory, not learning.
- "update": a saved note holds an older value of the SAME attribute of the SAME subject. Set "target". A different attribute of the same subject is "add", not "update".
- "reject": not durable (a status true only for this run, the agent's own plan, chatter).
Give each fact a short lowercase "subject" (the thing) and "attribute" (what about it). Reuse a saved note's exact subject and attribute when the fact is about the same thing. "value_kind": "id" for identifiers, account numbers, keys; "money" for prices and amounts; "rate" for percentages and rates; otherwise "other". "source": "user_stated" when the operator said it, "agent_inferred" when the agent concluded it, "fetched_web" when it came from a web page, "connector" when it came from a connected tool's data.

Output strict JSON, no prose, no fences:
{"artifacts":[{
  "action": "add" | "duplicate" | "update" | "reject",
  "target": "E1" (only for duplicate / update),
  "note_type": "agent_feedback" | "tenant_project" | "tenant_reference"__AGENT_PROCEDURAL__,
  "title": "short (<80 char) noun-phrase title",
  "body_markdown": "1-3 sentences, plain English, as if explaining to a new hire",
  "subject": "...", "attribute": "...",
  "value_kind": "id" | "money" | "rate" | "other",
  "source": "user_stated" | "agent_inferred" | "fetched_web" | "connector",
  "tags": ["short", "lowercase", "kebab-case"],
  "proposal_ref": "P1" (only when this fact answers an agent proposal),__USER_QUOTE__
  "reason": "one sentence: why this action"
}]}`;
