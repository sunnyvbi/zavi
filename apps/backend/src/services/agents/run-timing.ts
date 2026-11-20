
import { capturePlanStage } from "@/services/analytics/posthog";
import { logEventConfirmed } from "@/services/logging/logEvent";

type ToolAgg = { n: number; ms: number };
type Ledger = {
  t0: number;
  marks: Array<[string, number]>;
  queueMs?: number;
  tools: Map<string, ToolAgg>;
  open: Map<string, [string, number]>;
  closed: Map<string, number>;
  retried?: boolean;
  firstTextSource?: "delta" | "message";
  modelMs: number;
  turns: number;
  lastTurnId?: string;
  modelFrom: number | null;
};
const ledgers = new Map<string, Ledger>();
const MAX_LEDGERS = 2000;
export const RUN_TIMING_DB_AGENTS: ReadonlySet<string> = new Set(["cgo"]);
const OUTCOMES: ReadonlySet<string> = new Set(["ok", "parse_failed", "failed", "cancelled"]);
const TOOL_MS_MAX_CHARS = 256;

function placeLedger(runId: string, l: Ledger): void {
  ledgers.delete(runId);
  while (ledgers.size >= MAX_LEDGERS) {
    const oldest = ledgers.keys().next().value;
    if (oldest === undefined) break;
    ledgers.delete(oldest);
  }
  ledgers.set(runId, l);
}

function existingLedger(runId: string): Ledger | undefined {
  const l = ledgers.get(runId);
  if (l) placeLedger(runId, l);
  return l;
}

function ledgerFor(runId: string): Ledger {
  const l = existingLedger(runId) ?? {
    t0: Date.now(), marks: [], tools: new Map(), open: new Map(), closed: new Map(), modelMs: 0, turns: 0, modelFrom: null,
  };
  if (!ledgers.has(runId)) placeLedger(runId, l);
  return l;
}

export function markRunTiming(runId: string | null | undefined, label: string): void {
  if (!runId) return;
  const l = ledgerFor(runId);
  if (l.marks.some(([k]) => k === label)) return;
  l.marks.push([label, Date.now()]);
}

export function recordRunQueueMs(runId: string | null | undefined, ms: number | null | undefined): void {
  if (!runId || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return;
  const l = ledgerFor(runId);
  if (l.queueMs === undefined) l.queueMs = Math.round(ms);
}

const ATTEMPT_MARKS = new Set(["sdk_query_start", "sdk_first_message", "sdk_first_text", "sdk_result"]);

export function beginModelAttempt(runId: string | null | undefined, at: number = Date.now()): void {
  if (!runId) return;
  const l = ledgerFor(runId);
  l.marks = l.marks.filter(([k]) => !ATTEMPT_MARKS.has(k));
  l.marks.push(["sdk_query_start", at]);
  l.tools = new Map();
  l.open = new Map();
  l.closed = new Map();
  l.firstTextSource = undefined;
  l.modelMs = 0;
  l.turns = 0;
  l.lastTurnId = undefined;
  l.modelFrom = at;
}

export function noteModelStart(runId: string | null | undefined, at: number = Date.now()): void {
  if (!runId) return;
  ledgerFor(runId).modelFrom = at;
}

export function noteModelTurn(runId: string | null | undefined, messageId?: string | null, at: number = Date.now()): void {
  if (!runId) return;
  const l = ledgerFor(runId);
  if (!messageId || messageId !== l.lastTurnId) l.turns += 1;
  l.lastTurnId = messageId ?? undefined;
  if (l.modelFrom !== null) {
    l.modelMs += Math.max(0, at - l.modelFrom);
    l.modelFrom = at;
  }
}

export function noteToolStart(
  runId: string | null | undefined,
  toolUseId: string | null | undefined,
  name: string,
  at: number = Date.now(),
): void {
  if (!runId || !toolUseId) return;
  const l = ledgerFor(runId);
  l.modelFrom = null;
  if (!l.open.has(toolUseId) && !l.closed.has(toolUseId)) l.open.set(toolUseId, [name, at]);
}

function closeTool(l: Ledger, toolUseId: string, name: string, ms: number): number {
  l.open.delete(toolUseId);
  const agg = l.tools.get(name) ?? { n: 0, ms: 0 };
  agg.n += 1;
  agg.ms += ms;
  l.tools.set(name, agg);
  l.closed.set(toolUseId, ms);
  return ms;
}

export function noteModelText(
  runId: string | null | undefined,
  text: unknown,
  source: "delta" | "message",
  at: number = Date.now(),
): void {
  if (!runId || typeof text !== "string" || !text.trim()) return;
  const l = existingLedger(runId);
  if (!l || !l.marks.some(([k]) => k === "sdk_query_start") || l.marks.some(([k]) => k === "sdk_first_text")) return;
  l.marks.push(["sdk_first_text", at]);
  l.firstTextSource = source;
}

export function noteAssistantMessage(
  runId: string | null | undefined,
  messageId: string | null | undefined,
  blocks: ReadonlyArray<{ type: string; id?: string; name?: string; text?: string }>,
  at: number = Date.now(),
): void {
  noteModelTurn(runId, messageId, at);
  for (const b of blocks) {
    if (b.type === "text") noteModelText(runId, b.text, "message", at);
    if (b.type === "tool_use" && typeof b.id === "string") noteToolStart(runId, b.id, String(b.name ?? "unknown"), at);
  }
}

export function noteToolEnd(
  runId: string | null | undefined,
  toolUseId: string | null | undefined,
  at: number = Date.now(),
): number | undefined {
  if (!runId || !toolUseId) return undefined;
  const l = existingLedger(runId);
  if (!l) return undefined;
  const done = l.closed.get(toolUseId);
  if (done !== undefined) {
    l.closed.delete(toolUseId);
    return done;
  }
  const started = l.open.get(toolUseId);
  if (!started) return undefined;
  const ms = closeTool(l, toolUseId, started[0], Math.max(0, at - started[1]));
  l.closed.delete(toolUseId);
  return ms;
}

export async function closeToolTiming(runId: string | null | undefined, input: unknown): Promise<{ continue?: boolean }> {
  const h = (input ?? {}) as { tool_use_id?: unknown; tool_name?: unknown; duration_ms?: unknown };
  if (!runId || typeof h.tool_use_id !== "string") return {};
  const l = existingLedger(runId);
  if (!l || l.closed.has(h.tool_use_id)) return {};
  const started = l.open.get(h.tool_use_id);
  const name = typeof h.tool_name === "string" ? h.tool_name : started?.[0];
  const ms =
    typeof h.duration_ms === "number" && Number.isFinite(h.duration_ms) && h.duration_ms >= 0
      ? Math.round(h.duration_ms)
      : started
        ? Math.max(0, Date.now() - started[1])
        : undefined;
  if (name !== undefined && ms !== undefined) closeTool(l, h.tool_use_id, name, ms);
  return {};
}

export function summarizeRunTiming(l: Pick<Ledger, "t0" | "marks">): Record<string, number> {
  const out: Record<string, number> = {};
  let prev = l.t0;
  for (const [label, t] of l.marks) {
    out[label] = t - prev;
    prev = t;
  }
  out.total_ms = prev - l.t0;
  return out;
}

function summarizeRunStages(l: Ledger): Record<string, number | string> | null {
  const at = (label: string) => l.marks.find(([k]) => k === label)?.[1];
  const queryStart = at("sdk_query_start");
  const result = at("sdk_result");
  if (queryStart === undefined || result === undefined || l.turns === 0) return null;
  const claimed = at("claimed");
  const firstText = at("sdk_first_text");
  const persisted = at("persisted");
  const end = persisted ?? l.marks[l.marks.length - 1][1];
  const tools = [...l.tools.entries()].sort((a, b) => b[1].ms - a[1].ms);
  let toolMs = "";
  for (const [name, agg] of tools) {
    const entry = `${name.replace(/^mcp__server__/, "")}:${agg.n}:${agg.ms}`;
    const next = toolMs ? `${toolMs},${entry}` : entry;
    if (next.length > TOOL_MS_MAX_CHARS) break;
    toolMs = next;
  }
  const out: Record<string, number | string> = {
    ...(l.queueMs !== undefined ? { queue_ms: l.queueMs } : {}),
    ...(claimed !== undefined ? { prep_ms: queryStart - claimed } : {}),
    ...(firstText !== undefined ? { first_text_ms: firstText - queryStart } : {}),
    ...(l.firstTextSource ? { first_text_source: l.firstTextSource } : {}),
    model_ms: l.modelMs,
    model_turns: l.turns,
    tools_ms: tools.reduce((s, [, a]) => s + a.ms, 0),
    tool_calls: tools.reduce((s, [, a]) => s + a.n, 0),
    tool_search_calls: l.tools.get("ToolSearch")?.n ?? 0,
    ...(persisted !== undefined ? { post_ms: persisted - result } : {}),
    total_ms: end - (claimed ?? l.t0) + (l.queueMs ?? 0),
  };
  if (toolMs) out.tool_ms = toolMs;
  return out;
}

const PLAN_STAGE_FIELDS = [
  ["queue_ms", "queue"],
  ["prep_ms", "prep"],
  ["model_ms", "model"],
  ["tools_ms", "tools"],
  ["post_ms", "post_run"],
  ["total_ms", "run_total"],
] as const;

export function planBuildFields(payload: unknown): { plan_build?: true; first_plan?: boolean } {
  const p = payload as { stage?: unknown; origin?: unknown } | null | undefined;
  if (p?.stage !== "draft_strategy") return {};
  return { plan_build: true, first_plan: p.origin === "setup_draft" || p.origin === "setup_draft_paid" };
}

export async function flushRunTiming(
  runId: string | null | undefined,
  extra: Record<string, unknown> = {},
  tenantId?: string | null,
): Promise<void> {
  if (!runId) return;
  const l = ledgers.get(runId);
  if (!l) return;
  ledgers.delete(runId);
  let stages: Record<string, number | string> | null = null;
  try {
    stages = summarizeRunStages(l);
    console.log(JSON.stringify({ event: "run_timing", run_id: runId, ...extra, ms: summarizeRunTiming(l), ...(stages ? { stages } : {}) }));
  } catch {
  }
  const slug = typeof extra.agent_slug === "string" ? extra.agent_slug : "";
  if (!stages || !tenantId || !(RUN_TIMING_DB_AGENTS.has(slug) || extra.trigger === "mcp")) return;
  const outcome = typeof extra.outcome === "string" && OUTCOMES.has(extra.outcome) ? extra.outcome : "ok";
  if (extra.plan_build === true && !l.retried) {
    for (const [field, stage] of PLAN_STAGE_FIELDS) {
      const ms = stages[field];
      if (typeof ms === "number" && ms >= 0) capturePlanStage(tenantId, runId, stage, ms, { outcome, first_plan: extra.first_plan === true });
    }
  }
  const { ok } = await logEventConfirmed({
    level: "info",
    source: "run_timing",
    code: "run_timing",
    tenant_id: tenantId,
    run_id: runId,
    meta: { agent_slug: slug, outcome, ...stages },
  });
  if (!ok && !l.retried && !ledgers.has(runId)) {
    l.retried = true;
    placeLedger(runId, l);
  }
}

export const __testOnly = { ledgers };
