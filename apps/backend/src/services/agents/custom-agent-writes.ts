
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { isCustomAgentSlug } from "@/services/billing/tiers";
import { customRowAdmitsRun } from "./custom-agents";

export type CustomWriteRunFacts = { tenant_id: string; run_id: string; agent_id: string; slug: string };

export type CustomWriteRun =
  | { state: "not_custom" }
  | ({ state: "admitted" } & CustomWriteRunFacts)
  | ({ state: "blocked"; status: string } & CustomWriteRunFacts)
  | { state: "unverified" }
  | { state: "error"; reason: string };

export type CustomWriteIntent = { run: CustomWriteRunFacts; tool_name: string; decision_class: string | null };

export type CustomWriteReceipt = { tenant_id: string; id: string };

export type ReceiptOutcome = "attempted" | "succeeded" | "failed" | "blocked_paused";

export const CUSTOM_AGENT_PAUSED_MESSAGE =
  "This agent is paused, so it did not make this change. Resume it on its Agent Builder page to let it act again.";

export const CUSTOM_AGENT_RECEIPT_FAILED_MESSAGE =
  "This change was not made: its record could not be saved. Try again in a moment.";

export const CUSTOM_AGENT_UNVERIFIED_MESSAGE =
  "This change was not made: this agent could not be verified for this workspace.";

export const CUSTOM_AGENT_CHECK_FAILED_MESSAGE =
  "This change was not made: the agent's status could not be checked. Try again in a moment.";

const ERROR_MAX = 500;

export async function resolveCustomWriteRun(
  tenant_id: string,
  run_id: string | undefined | null,
  ctx_slug: string | undefined | null,
): Promise<CustomWriteRun> {
  if (!ctx_slug || !isCustomAgentSlug(ctx_slug)) return { state: "not_custom" };
  if (!tenant_id || !run_id) return { state: "unverified" };
  try {
    const tc = tenantClient(asTenantId(tenant_id));
    const { data: run, error: runErr } = await tc
      .from("agent_runs")
      .select("id, tenant_id, agent_slug, cron_dedupe_key")
      .eq("id", run_id)
      .eq("agent_slug", ctx_slug)
      .maybeSingle<{ id: string; tenant_id: string; agent_slug: string | null; cron_dedupe_key: string | null }>();
    if (runErr) return { state: "error", reason: "agent_runs_read_failed" };
    if (!run || run.id !== run_id || run.tenant_id !== tenant_id || run.agent_slug !== ctx_slug) {
      return { state: "unverified" };
    }
    const { data: row, error: rowErr } = await tc
      .from("custom_agents")
      .select("id, status, test_run_id")
      .eq("slug", ctx_slug)
      .maybeSingle<{ id: string; status: string; test_run_id: string | null }>();
    if (rowErr) return { state: "error", reason: "custom_agents_read_failed" };
    if (!row) return { state: "unverified" };
    const facts = { tenant_id: run.tenant_id, run_id: run.id, agent_id: row.id, slug: ctx_slug };
    return customRowAdmitsRun(row, { runId: run.id, cronDedupeKey: run.cron_dedupe_key })
      ? { state: "admitted", ...facts }
      : { state: "blocked", status: row.status, ...facts };
  } catch {
    return { state: "error", reason: "lookup_threw" };
  }
}

export async function insertWriteReceipt(
  run: CustomWriteRunFacts,
  tool_name: string,
  decision_class: string | null,
  outcome: ReceiptOutcome,
  error?: string | null,
): Promise<string | null> {
  try {
    const { data, error: insErr } = await tenantClient(asTenantId(run.tenant_id))
      .from("custom_agent_write_receipts")
      .insert({
        run_id: run.run_id,
        agent_id: run.agent_id,
        tool_name,
        decision_class,
        outcome,
        error: error ? error.slice(0, ERROR_MAX) : null,
      })
      .select("id")
      .single<{ id: string }>();
    if (insErr || !data) {
      console.warn(`[custom-agent-writes] receipt insert failed: ${insErr?.message ?? "no row"}`);
      return null;
    }
    return data.id;
  } catch (e) {
    console.warn(`[custom-agent-writes] receipt insert threw: ${(e as Error).message}`);
    return null;
  }
}

export async function settleWriteReceipt(
  receipt: CustomWriteReceipt,
  outcome: "succeeded" | "failed",
  error?: string | null,
): Promise<void> {
  try {
    const { error: upErr } = await tenantClient(asTenantId(receipt.tenant_id))
      .from("custom_agent_write_receipts")
      .update({ outcome, error: error ? error.slice(0, ERROR_MAX) : null })
      .eq("id", receipt.id);
    if (upErr) console.warn(`[custom-agent-writes] receipt settle failed: ${upErr.message}`);
  } catch (e) {
    console.warn(`[custom-agent-writes] receipt settle threw: ${(e as Error).message}`);
  }
}

export function receiptOutcomeOf(result: {
  is_error?: boolean;
  content?: unknown;
}): { outcome: "succeeded" | "failed"; error: string | null } {
  let parsed: Record<string, unknown> | null = null;
  if (typeof result.content === "string") {
    try {
      const v = JSON.parse(result.content);
      if (v && typeof v === "object" && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    } catch {
    }
  }
  if (result.is_error) {
    const code = parsed && typeof parsed.error === "string" ? parsed.error : "tool_error";
    return { outcome: "failed", error: code };
  }
  if (parsed && typeof parsed.status === "string" && "dispatch_error" in parsed) {
    if (parsed.status !== "executed") {
      const code = typeof parsed.dispatch_error === "string" ? parsed.dispatch_error : parsed.status;
      return { outcome: "failed", error: String(code) };
    }
  }
  return { outcome: "succeeded", error: null };
}

export async function settleAround<T extends { is_error?: boolean; content?: unknown }>(
  receipt: CustomWriteReceipt,
  write: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await write();
  } catch (e) {
    await settleWriteReceipt(receipt, "failed", "threw");
    throw e;
  }
  const { outcome, error } = receiptOutcomeOf(result);
  await settleWriteReceipt(receipt, outcome, error);
  return result;
}

export async function runCustomWrite<T extends { is_error?: boolean; content?: unknown }>(
  intent: CustomWriteIntent,
  write: () => Promise<T>,
  blockedResult: (code: string, message: string) => T,
): Promise<T> {
  const id = await insertWriteReceipt(intent.run, intent.tool_name, intent.decision_class, "attempted");
  if (!id) return blockedResult("custom_agent_receipt_failed", CUSTOM_AGENT_RECEIPT_FAILED_MESSAGE);
  return settleAround({ tenant_id: intent.run.tenant_id, id }, write);
}
