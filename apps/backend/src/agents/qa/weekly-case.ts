
import type { AgentContext, DispatcherResult } from "@/services/agents/types";
import type { BrowserTaskInput } from "@/services/browser-task/worker";
import { wrapUntrusted, type BrowserTaskResult } from "@/services/browser-task/output";

export const QA_WEEKLY_TRIGGER = "qa-weekly-execute";
export const QA_WEEKLY_SOURCE = "qa_weekly_execute";

type CasePayload = { source?: unknown; staging_origin?: unknown; intent?: unknown; test_case_id?: unknown };

export function isQaWeeklyCaseRun(ctx: Pick<AgentContext, "trigger">, payload: unknown): boolean {
  const p = (payload ?? {}) as CasePayload;
  return (
    ctx.trigger === QA_WEEKLY_TRIGGER &&
    p.source === QA_WEEKLY_SOURCE &&
    typeof p.staging_origin === "string" &&
    typeof p.intent === "string"
  );
}

export type QaVerdictOut = {
  test_result: "pass" | "fail" | "blocked";
  blocked_kind: null | "infra" | "needs_write" | "off_origin" | "missing_precondition";
  reason: string;
  evidence: string;
};

const VERDICT_RULES =
  "\n\nANSWER FORMAT (mandatory): start your answer with exactly one of " +
  "PASS:, FAIL:, BLOCKED(needs_write):, BLOCKED(off_origin):, BLOCKED(missing_precondition):, BLOCKED(infra): " +
  "then one or two lines on why, citing what you observed. FAIL means the page loaded and what you saw contradicts " +
  "the expected outcome; if you could not tell, use BLOCKED. You cannot click or type: if checking the outcome needs " +
  "that, use BLOCKED(needs_write).";

function noFences(t: string): string {
  return t.replace(/`{3,}/g, "\u2018\u2018\u2018");
}

const VERDICT_FIELD_MAX = 500;

export function verdictFromResult(r: BrowserTaskResult): QaVerdictOut {
  const rawEvidence = noFences(r.final_url ?? r.facts[0] ?? "");
  const evidence = rawEvidence ? wrapUntrusted(rawEvidence, VERDICT_FIELD_MAX) : "";
  if (r.status === "busy" || r.status === "disabled") {
    return { test_result: "blocked", blocked_kind: "infra", reason: `browser ${r.status}: ${r.blocked_reason ?? ""}`.trim(), evidence };
  }
  const answer = noFences(r.answer).trim();
  const m = /^(PASS|FAIL|BLOCKED)(?:\((needs_write|off_origin|missing_precondition|infra)\))?\s*:\s*/i.exec(answer);
  const said = (m ? answer.slice(m[0].length) : answer).trim();
  const reason = said ? wrapUntrusted(said, VERDICT_FIELD_MAX) : r.blocked_reason ?? "no answer";
  if (m) {
    const kind = m[1].toUpperCase();
    if (kind === "PASS" && r.status === "done") return { test_result: "pass", blocked_kind: null, reason, evidence };
    if (kind === "FAIL" && r.status === "done") return { test_result: "fail", blocked_kind: null, reason, evidence };
    if (kind === "BLOCKED") {
      const bk = (m[2]?.toLowerCase() ?? "infra") as QaVerdictOut["blocked_kind"];
      return { test_result: "blocked", blocked_kind: bk, reason, evidence };
    }
  }
  const offOrigin = r.blocked_reason === "off_origin";
  return { test_result: "blocked", blocked_kind: offOrigin ? "off_origin" : "infra", reason, evidence };
}

export async function runQaWeeklyCase(
  ctx: Pick<AgentContext, "tenant_id" | "runId">,
  payload: unknown,
  run: (input: BrowserTaskInput) => Promise<BrowserTaskResult> = async (i) =>
    (await import("@/services/browser-task/worker")).runBrowserTask(i),
): Promise<DispatcherResult> {
  const p = payload as CasePayload;
  const staging = String(p.staging_origin);
  const result = await run({
    tenant_id: ctx.tenant_id,
    run_id: ctx.runId,
    tool_use_id: `qa-weekly-case:${ctx.runId}`,
    goal: `${String(p.intent)}${VERDICT_RULES}`,
    start_url: staging,
    allowed_origin: staging,
  });
  const verdict = verdictFromResult(result);
  const answer = noFences(result.answer);
  const body = [
    answer ? wrapUntrusted(answer) : `The browser task ended with status ${result.status}.`,
    result.see_what_i_saw_url ? `See what I saw: ${result.see_what_i_saw_url}` : "",
    "```json",
    JSON.stringify({ qa_verdict: verdict }),
    "```",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    output_text: body,
    parsed: null,
    parse_ok: true,
    raw_response_text: body,
    prompt_snapshot: "",
    usage: { input_tokens: 0, output_tokens: 0 },
    side_effect: { kind: "none" },
    tool_calls: [],
  };
}
