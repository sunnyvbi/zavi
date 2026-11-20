import { parseMoveTest, type MoveTest } from "./cgo-test-shape";
import { isServerEnvelope } from "./test-envelope";

export const CGO_REPLY_STATUSES = ["completed", "rejected", "input_required"] as const;
export type CgoReplyStatus = (typeof CGO_REPLY_STATUSES)[number];

export type CgoReply = {
  status: CgoReplyStatus;
  reason?: string;
  question?: string;
  summary: string;
  warning?: "missing" | "garbled";
};

export type CgoBrief = {
  goal: {
    objective: string;
    target_metric: string;
    target_value: number | null;
    current_value: number | null;
    number_trusted: boolean;
    due_date: string | null;
  };
  judged_on: string;
  problem: string;
  boundaries: string[];
  expected_output: string | null;
  why: string | null;
  test?: MoveTest | null;
};

const cut = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? cut(v, max) : null);

export function serverBoundaries(kind: "ad" | "organic", adLeftUsd?: number | null): string[] {
  const out =
    kind === "ad"
      ? [
          adLeftUsd != null
            ? `Spend only inside the founder's ad budget: $${Math.floor(adLeftUsd)} left this month.`
            : "Spend only inside the founder's ad budget.",
          "Submit budget and status changes through the approval gate; saved owner controls decide unattended authority.",
        ]
      : ["Drafts only: nothing is posted, sent or published without the founder's click."];
  out.push("If this order goes against one of your own open cards, do not do it: reply rejected.");
  return out;
}

export function buildCgoBrief(args: {
  goal: { objective: string; target_metric: string; target_value: number | null; current_value: number | null; due_date: string | null };
  number_trusted: boolean;
  body: { problem?: unknown; moves_metric?: unknown; boundaries?: unknown; expected_output?: unknown; context_summary?: unknown; test?: unknown };
  kind: "ad" | "organic";
  adLeftUsd?: number | null;
}): CgoBrief {
  const g = args.goal;
  const own = str(args.body.boundaries, 300);
  return {
    goal: {
      objective: cut(g.objective, 200),
      target_metric: cut(g.target_metric, 80),
      target_value: g.target_value == null ? null : Number(g.target_value),
      current_value: g.current_value == null ? null : Number(g.current_value),
      number_trusted: args.number_trusted,
      due_date: g.due_date,
    },
    judged_on: str(args.body.moves_metric, 80) ?? cut(g.target_metric, 80),
    problem: str(args.body.problem, 40) ?? "unspecified",
    boundaries: [...(own ? [own] : []), ...serverBoundaries(args.kind, args.adLeftUsd)],
    expected_output: str(args.body.expected_output, 300),
    why: str(args.body.context_summary, 500),
    test: parseMoveTest(args.body.test) ?? null,
  };
}

export function cgoBriefOf(payload: unknown): CgoBrief | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const b = (payload as { cgo_brief?: unknown }).cgo_brief;
  if (!b || typeof b !== "object") return null;
  const x = b as Partial<CgoBrief>;
  return x.goal && typeof x.goal === "object" && typeof x.judged_on === "string" ? (b as CgoBrief) : null;
}

const num = (n: number | null) => (n == null ? "unknown" : String(n));

export function renderCgoBrief(b: CgoBrief): string {
  const g = b.goal;
  const lines = [
    "## Brief from cgo (head of growth)",
    `Goal: ${g.objective}. ${g.target_metric} now ${num(g.current_value)}${g.number_trusted ? "" : " (not a trusted number)"}, target ${num(g.target_value)}${g.due_date ? ` by ${g.due_date}` : ""}.`,
    `Judged on: ${b.judged_on}`,
    `Problem: ${b.problem}`,
    `Boundaries: ${b.boundaries.join(" ")}`,
    ...(b.expected_output ? [`Hand back: ${b.expected_output}`] : []),
    ...(b.why ? [`Why: ${b.why}`] : []),
    ...(b.test
      ? [
          `This order is a test. Change ONLY: ${b.test.variable}.${b.test.budget_usd != null ? (isServerEnvelope(b.test) ? ` Planned test spend: about $${b.test.budget_usd}; Zavi sets the stop from what runs.` : ` Test budget: $${b.test.budget_usd} in total.`) : ""} Baseline: ${b.test.baseline}.${isServerEnvelope(b.test) ? " If you change an existing daily budget, the test puts it back to the daily it had just before your change when it ends (a card the founder approves)." : b.test.baseline_daily_usd != null ? ` If you change an existing daily budget, the test puts it back to $${b.test.baseline_daily_usd} a day when it ends (a card the founder approves).` : ""} It worked if: ${b.test.success_if}.${b.test.stop_if ? ` Stop if: ${b.test.stop_if}.` : ""} ${b.test.stop_rule ? `Stop rule: ${b.test.stop_rule}. ` : ""}Read out on ${b.test.readout_on}. Name the ids of what you create or change in your reply's summary.`,
        ]
      : []),
    "The order is `intent` in the run context below.",
    "",
  ];
  return lines.join("\n");
}

export const CGO_REPLY_INSTRUCTION = [
  "",
  "## Reply to cgo",
  'Add a top-level "cgo_reply" key to your JSON output: {"status": "completed" | "rejected" | "input_required", "reason": "<why you did not do it>", "question": "<the one answer you need>", "summary": "<one sentence: what you did or found>"}.',
  "rejected = you did not do it (it breaks a boundary, goes against your own open card, or cannot work here). input_required = you need one answer before you can. Do no part of an order you reject.",
].join("\n");

export function withCgoBrief(payload: unknown, userTurn: string): string {
  const b = cgoBriefOf(payload);
  return b ? `${renderCgoBrief(b)}\n${userTurn}\n${CGO_REPLY_INSTRUCTION}` : userTurn;
}

function objectAt(text: string, open: number): string | null {
  let depth = 0;
  let inStr = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}

function findReply(parsed: unknown, texts: string[]): { found: false } | { found: true; value: unknown } {
  if (parsed && typeof parsed === "object" && "cgo_reply" in (parsed as object)) {
    return { found: true, value: (parsed as { cgo_reply: unknown }).cgo_reply };
  }
  for (const t of texts) {
    if (!t) continue;
    const tag = /<cgo_reply>([\s\S]*?)<\/cgo_reply>/i.exec(t);
    if (tag) {
      try {
        return { found: true, value: JSON.parse(tag[1].trim()) };
      } catch {
        return { found: true, value: tag[1] };
      }
    }
    const key = /"cgo_reply"\s*:\s*/.exec(t);
    if (key) {
      const at = key.index + key[0].length;
      const obj = t[at] === "{" ? objectAt(t, at) : null;
      if (!obj) return { found: true, value: t.slice(at, at + 200) };
      try {
        return { found: true, value: JSON.parse(obj) };
      } catch {
        return { found: true, value: obj };
      }
    }
  }
  return { found: false };
}

export function parseCgoReply(parsed: unknown, texts: string[], fallbackSummary = ""): CgoReply {
  const fallback = cut(fallbackSummary, 300);
  const hit = findReply(parsed, texts);
  if (!hit.found) return { status: "completed", summary: fallback, warning: "missing" };
  const v = hit.value;
  const status = v && typeof v === "object" ? (v as { status?: unknown }).status : undefined;
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (!(CGO_REPLY_STATUSES as readonly string[]).includes(s)) {
    return { status: "completed", summary: fallback, warning: "garbled" };
  }
  const o = v as Record<string, unknown>;
  const summary = str(o.summary, 300) ?? fallback;
  const reason = str(o.reason, 300);
  const question = str(o.question, 300);
  return {
    status: s as CgoReplyStatus,
    summary,
    ...(s === "rejected" ? { reason: reason ?? "no reason given" } : {}),
    ...(s === "input_required" ? { question: question ?? summary } : {}),
  };
}

export function cgoReplyOf(parsed: unknown): CgoReply | null {
  if (!parsed || typeof parsed !== "object") return null;
  const r = (parsed as { cgo_reply?: unknown }).cgo_reply;
  if (!r || typeof r !== "object") return null;
  const s = (r as { status?: unknown }).status;
  return typeof s === "string" && (CGO_REPLY_STATUSES as readonly string[]).includes(s) ? (r as CgoReply) : null;
}

export function attachCgoReply<R extends { parsed: unknown; output_text: string; raw_response_text?: string }>(payload: unknown, result: R): R {
  try {
    if (!cgoBriefOf(payload)) return result;
    const reply = parseCgoReply(result.parsed, [result.output_text, result.raw_response_text ?? ""], result.output_text);
    const base = result.parsed && typeof result.parsed === "object" && !Array.isArray(result.parsed) ? (result.parsed as Record<string, unknown>) : {};
    result.parsed = { ...base, cgo_reply: reply };
    if (/<cgo_reply>/i.test(result.output_text)) {
      result.output_text = result.output_text.replace(/<cgo_reply>[\s\S]*?<\/cgo_reply>/gi, "").trim();
    }
  } catch (e) {
    console.warn(`[cgo-brief] reply parse threw (run unaffected): ${(e as Error).message}`);
  }
  return result;
}

export const REJECTED_ORDER_DAYS = 14;

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9$%. ]+/g, " ").split(/\s+/).filter((w) => w.length > 2));

export function sameOrder(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return false;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter) >= 0.6;
}

export type RejectedOrder = {
  target: string;
  goal_id: string | null;
  intent: string;
  reason: string;
  briefed_value: number | null;
  briefed_rev: string | null;
  rejected_at?: string | null;
  founder_closed_cited?: boolean;
};

export function repeatsRejected(
  move: { target: string; goal_id: string; intent: string },
  goalNow: { current_value: number | null; rev: string },
  rejected: readonly RejectedOrder[],
): RejectedOrder | null {
  const now = goalNow.current_value == null ? null : Number(goalNow.current_value);
  for (const r of rejected) {
    if (r.target !== move.target || r.goal_id !== move.goal_id || !sameOrder(r.intent, move.intent)) continue;
    if (r.founder_closed_cited) continue;
    if (r.briefed_value !== now) continue;
    if (r.briefed_rev !== null && r.briefed_rev !== goalNow.rev) continue;
    return r;
  }
  return null;
}
