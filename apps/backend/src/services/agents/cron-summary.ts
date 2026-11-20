
import { serviceClient } from "@/services/supabase";
import type { CronRunOutcome } from "@/services/agents/cron-outcome";
import { chatFailureBubbleBody } from "@/services/agents/error-body";

export type CronSummaryInput = {
  tenant_id: string;
  agent_slug: string;
  run_id: string;
  status: string;
  cost_usd: number | null;
  summary_text?: string;
  outcome?: CronRunOutcome | null;
};

export function cronOutcomeLabel(
  outcome: CronRunOutcome | null | undefined,
): string | null {
  switch (outcome) {
    case "produced_decision":
      return "produced: a decision";
    case "produced_note":
      return "produced: a note";
    case "produced_artifact":
      return "produced: an artifact";
    case "empty":
      return "produced: nothing";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

export function cronFailureSummaryText(rawError: string, agentSlug: string): string {
  return chatFailureBubbleBody(rawError, agentSlug).slice(0, 200);
}

export async function writeCronRunSummary(
  input: CronSummaryInput,
): Promise<void> {
  const sb = serviceClient();

  const { data: threadId, error: terr } = await sb.rpc(
    "get_or_create_synthetic_cron_thread",
    {
      p_tenant_id: input.tenant_id,
      p_agent_slug: input.agent_slug,
    },
  );
  if (terr) throw new Error(`synthetic thread upsert failed: ${terr.message}`);
  if (!threadId) throw new Error("synthetic thread upsert returned no id");

  const body: {
    run_id: string;
    status: string;
    cost_usd: number | null;
    summary: string;
    outcome?: CronRunOutcome;
  } = {
    run_id: input.run_id,
    status: input.status,
    cost_usd: input.cost_usd,
    summary: input.summary_text ?? "",
  };
  if (input.outcome != null) body.outcome = input.outcome;

  const { error: ierr } = await sb.from("agent_thread_messages").insert({
    thread_id: threadId,
    tenant_id: input.tenant_id,
    sender_role: "system",
    body: JSON.stringify(body),
    agent_run_id: input.run_id,
    source: "cron",
    meta: {},
  });
  if (ierr) throw new Error(`cron summary insert failed: ${ierr.message}`);
}
