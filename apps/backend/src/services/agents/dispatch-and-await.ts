
import { serviceClient } from "@/services/supabase";
import { enqueueAgentRun, SafetyGateError, AgentNotFoundError } from "./runner";
import { ensureAgentRunnable } from "./ensure-runnable";

export const DISPATCH_CORRELATION_KEY = "_dispatch_correlation";

export type AgentDispatchAwaitInput = {
  tenant_id: string;
  agent_slug: string;
  payload: Record<string, unknown>;
  trigger: "cron" | "a2a" | "webhook" | "manual";
  cron_dedupe_key?: string;
  correlation_id?: string;
};

export type AgentDispatchResult = {
  agent_run_id: string;
  was_dedupe_hit: boolean;
};

export async function dispatchAgentForCompletionEvent(
  input: AgentDispatchAwaitInput,
): Promise<AgentDispatchResult> {
  const check = await ensureAgentRunnable(input.tenant_id, input.agent_slug, {
    run: { trigger: input.trigger, enqueuedByUser: false, payload: input.payload },
  });
  if (!check.runnable) {
    if (check.reason === "not_found") {
      throw new AgentNotFoundError(input.agent_slug);
    }
    throw new SafetyGateError(input.agent_slug, check.detail);
  }

  let finalPayload = input.payload;
  if (input.correlation_id !== undefined) {
    if (
      input.payload &&
      Object.prototype.hasOwnProperty.call(input.payload, DISPATCH_CORRELATION_KEY)
    ) {
      throw new Error(
        `dispatchAgentForCompletionEvent: payload already contains reserved key ` +
          `"${DISPATCH_CORRELATION_KEY}" — refusing to overwrite with correlation_id`,
      );
    }
    finalPayload = {
      ...input.payload,
      [DISPATCH_CORRELATION_KEY]: input.correlation_id,
    };
  }

  const { run_id } = await enqueueAgentRun({
    agent_slug: input.agent_slug,
    tenant_id: input.tenant_id,
    trigger: input.trigger,
    payload: finalPayload,
    cron_dedupe_key: input.cron_dedupe_key ?? null,
  });

  if (run_id !== "") {
    return { agent_run_id: run_id, was_dedupe_hit: false };
  }

  if (!input.cron_dedupe_key) {
    throw new Error(
      "dispatchAgentForCompletionEvent: enqueueAgentRun returned empty run_id " +
        "without a cron_dedupe_key — shouldn't happen (sentinel only fires " +
        "on ON CONFLICT DO NOTHING path of the dedupe-key unique index).",
    );
  }

  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select("id")
    .eq("cron_dedupe_key", input.cron_dedupe_key)
    .eq("tenant_id", input.tenant_id)
    .order("enqueued_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `dispatchAgentForCompletionEvent: dedupe-recovery SELECT failed: ${error.message}`,
    );
  }
  if (!data) {
    throw new Error(
      `dispatchAgentForCompletionEvent: enqueueAgentRun returned dedupe sentinel ` +
        `(cron_dedupe_key=${input.cron_dedupe_key}, tenant_id=${input.tenant_id}) ` +
        `but no prior row found — shouldn't happen (sentinel implies prior row exists). ` +
        `Likely cross-tenant key collision; tenant-prefix dedupe keys per helper docs.`,
    );
  }

  return { agent_run_id: data.id, was_dedupe_hit: true };
}
