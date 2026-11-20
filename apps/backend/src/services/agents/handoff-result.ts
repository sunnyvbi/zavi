
import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyReceipt, type ReceiptEvidence } from "./receipt-verifier";
import { chatFailureBubbleBody } from "./error-body";
import { logEvent } from "@/services/logging/logEvent";
import { CGO_NO_USABLE_ANSWER, cgoHandoffReplyBody, isCgoHandoffAnswer } from "@/agents/cgo/handoff-answer";
import type { RunOutcome } from "./outcome-model";
import {
  composeCustomerStatusBody,
  projectRunStatus,
  STATUS_PHRASES,
  type ProjectableRun,
} from "./run-status-projection";

export type HandoffResultArgs = {
  tenant_id: string;
  run_id: string;
  operator_thread_id: string;
  from_agent_slug: string;
  status: "success" | "error" | "failed";
  parse_failed?: boolean;
  output_text?: string | null;
  raw_response_text?: string | null;
  error?: string | null;
  outcome?: Partial<RunOutcome> | null;
  parsed?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
  evidence?: ReceiptEvidence;
};

const MAX_BODY = 32000;

export function composeHandoffBody(args: HandoffResultArgs): string {
  const cgoAnswer = isCgoHandoffAnswer(args.from_agent_slug, "handoff", args.payload);
  if (args.status === "success" && !args.parse_failed && cgoAnswer) {
    const prose = cgoHandoffReplyBody(args.output_text) ?? cgoHandoffReplyBody(args.outcome?.deliverable ?? null);
    if (prose) return prose.length > MAX_BODY ? prose.slice(0, MAX_BODY) : prose;
    return CGO_NO_USABLE_ANSWER;
  }
  const runStatus: string =
    args.status === "success" ? "success" : args.parse_failed ? "parse_failed" : "failed";
  const cgoFragment = cgoAnswer && runStatus !== "success";
  const outcome = cgoFragment && args.outcome ? { ...args.outcome, deliverable: null, customer_summary: null } : (args.outcome ?? null);
  const run: ProjectableRun = {
    id: args.run_id,
    agent_slug: args.from_agent_slug,
    status: runStatus,
    outcome,
    parsed: args.parsed ?? null,
    payload: args.payload ?? null,
    output_text: runStatus === "failed" || cgoFragment ? null : (args.output_text ?? null),
  };
  const status = projectRunStatus(run);
  let body = composeCustomerStatusBody(status);

  if (args.status !== "success" && !args.parse_failed && !status.summary) {
    const detail = chatFailureBubbleBody(args.error ?? null, args.from_agent_slug).trim();
    if (detail.length > 0 && detail !== STATUS_PHRASES.couldnt) body = `${body}\n\n${detail}`;
  }

  if (args.status === "success") {
    const prReceipts = status.links.filter((l) => l.kind === "pr").map((l) => `pr_url:${l.url}`);
    const evidence: ReceiptEvidence | undefined =
      prReceipts.length > 0
        ? { ...(args.evidence ?? {}), receipts: [...(args.evidence?.receipts ?? []), ...prReceipts] }
        : args.evidence;
    if (verifyReceipt({ body, evidence }).hedged) {
      void logEvent({
        level: "warn",
        source: "agent.receipt-verifier",
        code: "receipt_unverified",
        tenant_id: args.tenant_id,
        run_id: args.run_id,
        meta: { agent_slug: args.from_agent_slug, surface: "handoff" },
      });
    }
  }

  return body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body;
}

export function isHandoffChildPayload(
  payload: Record<string, unknown> | null | undefined,
): boolean {
  return (
    payload?.handoff_child === true ||
    payload?.slack_handoff_child === true ||
    payload?.whatsapp_handoff_child === true
  );
}

export function handoffChildReplyText(
  run: {
    status: string | null;
    output_text: string | null;
    agent_slug: string | null;
    payload: Record<string, unknown> | null;
    outcome?: Partial<RunOutcome> | null;
    parsed?: Record<string, unknown> | null;
  },
  run_id: string,
): string {
  const success = run.status === "success";
  const parseFailed = run.status === "parse_failed";
  return composeHandoffBody({
    tenant_id: "",
    run_id,
    operator_thread_id: "",
    from_agent_slug: run.agent_slug ?? "specialist",
    status: success ? "success" : "failed",
    parse_failed: parseFailed,
    output_text: run.output_text,
    outcome: run.outcome ?? null,
    parsed: run.parsed ?? null,
    payload: run.payload,
  }).trim();
}

export type RecordHandoffRpc = (params: {
  p_operator_thread_id: string;
  p_tenant_id: string;
  p_run_id: string;
  p_body: string;
}) => Promise<{ error: { message: string; code?: string } | null }>;

export async function postHandoffResultToOperatorThread(
  args: HandoffResultArgs,
  recordRpc: RecordHandoffRpc,
): Promise<boolean> {
  const body = composeHandoffBody(args);
  try {
    const { error } = await recordRpc({
      p_operator_thread_id: args.operator_thread_id,
      p_tenant_id: args.tenant_id,
      p_run_id: args.run_id,
      p_body: body,
    });
    if (error) {
      console.warn(
        `[handoff-result] record_handoff_chat_message RPC error — ` +
          JSON.stringify({
            run_id: args.run_id,
            operator_thread_id: args.operator_thread_id,
            tenant_id: args.tenant_id,
            from_agent_slug: args.from_agent_slug,
            rpc_error_code: error.code ?? null,
            rpc_message: error.message,
          }),
      );
      return false;
    }
    return true;
  } catch (e) {
    console.warn(
      `[handoff-result] record_handoff_chat_message threw — ` +
        JSON.stringify({
          run_id: args.run_id,
          operator_thread_id: args.operator_thread_id,
          tenant_id: args.tenant_id,
          from_agent_slug: args.from_agent_slug,
          error_message: (e as Error).message,
        }),
    );
    return false;
  }
}

export const PARENT_REPLY_WAIT_MS = 120_000;
export const PARENT_REPLY_POLL_MS = 3_000;
const PARENT_WORKING = new Set(["queued", "running", "blocked"]);

export async function parentReplyPending(
  sb: SupabaseClient,
  tenant_id: string,
  parent_run_id: string | null | undefined,
): Promise<boolean> {
  if (!parent_run_id) return false;
  try {
    const { data: reply, error: replyErr } = await sb
      .from("agent_thread_messages")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("agent_run_id", parent_run_id)
      .eq("sender_role", "assistant")
      .limit(1);
    if (replyErr || (Array.isArray(reply) && reply.length > 0)) return false;
    const { data: parent, error: parentErr } = await sb
      .from("agent_runs")
      .select("status")
      .eq("tenant_id", tenant_id)
      .eq("id", parent_run_id)
      .maybeSingle();
    if (parentErr || !parent) return false;
    return PARENT_WORKING.has(String((parent as { status?: unknown }).status));
  } catch {
    return false;
  }
}

export async function waitForParentReply(
  pending: () => Promise<boolean>,
  opts: { maxMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  const maxMs = opts.maxMs ?? PARENT_REPLY_WAIT_MS;
  const pollMs = opts.pollMs ?? PARENT_REPLY_POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let waited = 0;
  while (waited < maxMs && (await pending())) {
    await sleep(pollMs);
    waited += pollMs;
  }
  return waited;
}
