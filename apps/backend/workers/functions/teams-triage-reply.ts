
/* eslint-disable @typescript-eslint/no-explicit-any */

import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { postTeamsReply } from "@/services/tools/teams/_client";
import { logEvent } from "@/services/logging/logEvent";
import { handoffChildReplyText, isHandoffChildPayload } from "@/services/agents/handoff-result";
import type { RunOutcome } from "@/services/agents/outcome-model";

const MAX_BODY = 28_000;

const TERMINAL_FAILED_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "parse_failed",
  "dispatch_error",
  "error",
]);

type RunRow = {
  tenant_id: string;
  trigger: string | null;
  status: string | null;
  output_text: string | null;
  agent_slug: string | null;
  payload: Record<string, unknown> | null;
  outcome: Partial<RunOutcome> | null;
  parsed: Record<string, unknown> | null;
};

export async function replyOne(run_id: string): Promise<unknown> {
  const svc = serviceClient();

  const { data: run } = await svc
    .from("agent_runs")
    .select("tenant_id, trigger, status, output_text, agent_slug, payload, outcome, parsed")
    .eq("id", run_id)
    .maybeSingle<RunRow>();
  if (!run) return { skip: "run_not_found" };
  if (run.trigger !== "teams") return { skip: "not_teams_triage" };

  if ((run.payload as { teams_reply_delegated?: unknown })?.teams_reply_delegated === true) {
    return { skip: "teams_reply_delegated" };
  }

  const teams = ((run.payload?.teams as Record<string, unknown>) ?? {}) as {
    conversation_reference?: unknown;
    m365_tenant_id?: string;
  };
  const conversationReference = teams.conversation_reference;
  if (!conversationReference) return { skip: "no_teams_routing" };

  const { error: claimErr } = await svc
    .from("teams_reply_claims")
    .insert({ run_id, tenant_id: run.tenant_id });
  if (claimErr) {
    return { skip: "reply_already_handled" };
  }

  async function releaseClaim() {
    await svc.from("teams_reply_claims").delete().eq("run_id", run_id);
  }

  const handoffChildTerminalFailure =
    isHandoffChildPayload(run.payload) && TERMINAL_FAILED_STATUSES.has(run.status ?? "");
  const refusedWithExplanation = run.status === "failed" && run.outcome?.failure?.class === "policy_refusal";
  if (run.status !== "success" && !handoffChildTerminalFailure && !refusedWithExplanation) {
    await logEvent({
      level: "warn",
      source: "teams-triage-reply",
      code: "teams.reply.run_failed",
      message: `teams run ${run_id} status=${run.status}; no reply sent`,
      tenant_id: run.tenant_id,
    });
    return { skip: "run_not_success", status: run.status };
  }

  let body = isHandoffChildPayload(run.payload)
    ? handoffChildReplyText(run, run_id)
    : (run.output_text ?? "").trim();
  if (!body) {
    await releaseClaim();
    return { skip: "empty_output" };
  }
  if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY);

  const result = await postTeamsReply({ conversationReference, text: body, aiGenerated: true });
  if (!result.ok) {
    if (result.gone) {
      if (teams.m365_tenant_id) {
        await svc
          .from("teams_tenants")
          .update({ status: "deleted", updated_at: new Date().toISOString() })
          .eq("m365_tenant_id", teams.m365_tenant_id);
      }
      await logEvent({
        level: "warn",
        source: "teams-triage-reply",
        code: "teams.reply.conversation_gone",
        message: `teams conversation gone for run ${run_id}: ${result.error}`,
        tenant_id: run.tenant_id,
      });
      return { skip: "conversation_gone", error: result.error };
    }
    await releaseClaim();
    return { skip: "send_failed", error: result.error, run_id };
  }

  return { sent: true, run_id };
}

export const teamsTriageReplyFn = inngest.createFunction(
  { id: "teams-triage-reply", retries: 1, concurrency: 4 },
  { event: "agent.run.completed" },
  async ({ event, step, logger }) => {
    const run_id = event.data.run_id;
    const res = await step.run("reply", () => replyOne(run_id));
    logger.info(`teams-triage-reply ${run_id}: ${JSON.stringify(res)}`);
    return res;
  },
);
