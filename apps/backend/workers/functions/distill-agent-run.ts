
import { inngest } from "../client";
import { runPhaseOf } from "@zavi/shared";
import { distillConcurrency } from "./distill-concurrency";
import { serviceClient } from "@/services/supabase";
import {
  AGENT_RUN_DISTILL_SYSTEM_PROMPT,
  runDistill,
} from "@/services/memory/distill";
import { shouldDistillRun } from "@/services/agents/should-distill";
import { renderUntrustedBlock } from "@/services/agents/prompt-injection";
import { recordConnectorSkillForRun } from "@/services/agents/connector-skill";
import { liveConnectorsForTenant } from "@/services/memory/live-connectors";
import { junkReasonForRunOutput } from "@/services/memory/junk-filter";
import { loadPendingProposals, recordWrites } from "@/services/memory/write-path";
import { PROPOSALS_ONLY_NOTE } from "@/services/memory/write-gate";
import type { ToolCallTrace } from "@/services/tools/types";

type AgentRunRow = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  trigger: string;
  status: string;
  output_text: string | null;
  distilled_at: string | null;
  parsed: { seed?: boolean } | null;
};

const MAX_DISTILL_PER_TENANT_PER_DAY = (() => {
  const raw = Number(process.env.PRAXIS_MAX_DISTILL_PER_TENANT_PER_DAY ?? "10");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10;
})();

type ReasoningEventRow = {
  body: { text?: string; iter?: number } | null;
  created_at: string;
};

const MAX_USER_PROMPT_CHARS = 12_000;
const MAX_REASONING_ROWS = 5;

export function isExcludedFromCompanyBrain(run: {
  trigger?: string | null;
  payload?: { source?: string } | null;
}): boolean {
  return (
    run.payload?.source === "slack_onboarding_research" || run.trigger === "channel_recipe"
  );
}

export async function distillAgentRun(run_id: string): Promise<{ written: number; skipped: number }> {
  if (process.env.PRAXIS_DISTILL_AGENT_RUN_ENABLED === "0") {
    return { written: 0, skipped: 0 };
  }

  const svc = serviceClient();

  const { data: runData, error: runErr } = await svc
    .from("agent_runs")
    .select("id, tenant_id, agent_slug, trigger, status, output_text, distilled_at, parsed, payload, tool_calls")
    .eq("id", run_id)
    .maybeSingle();
  if (runErr) throw new Error(`agent_runs read failed: ${runErr.message}`);
  if (!runData) return { written: 0, skipped: 0 };
  const run = runData as AgentRunRow & { payload?: { source?: string } | null };

  const proposals = await loadPendingProposals(run.tenant_id, run.id);
  const hasProposals = proposals.length > 0;
  const markDistilled = async () => {
    const { error } = await svc
      .from("agent_runs")
      .update({ distilled_at: new Date().toISOString() })
      .eq("id", run.id);
    return error;
  };

  let useTranscript = !run.distilled_at;
  if (!useTranscript && !hasProposals) return { written: 0, skipped: 0 };

  if (useTranscript && isExcludedFromCompanyBrain(run)) {
    if (!hasProposals) {
      const markErr = await markDistilled();
      if (markErr) throw new Error(`onboarding-distill-skip mark failed: ${markErr.message}`);
      return { written: 0, skipped: 0 };
    }
    useTranscript = false;
  }

  if (run.status !== "success") return { written: 0, skipped: 0 };
  if (run.trigger === "chat") return { written: 0, skipped: 0 };

  if (!run.distilled_at) {
    try {
      await recordConnectorSkillForRun({
        tenant_id: run.tenant_id,
        tool_calls: (run as { tool_calls?: unknown }).tool_calls,
        run_id: run.id,
      });
    } catch (e) {
      console.warn(
        `[distill-agent-run] connector-skill record failed for run ${run.id}: ${(e as Error).message}`,
      );
    }
  }
  const output_text = run.output_text ?? "";
  const is_seed = run.parsed?.seed === true;
  const gate = shouldDistillRun({
    agent_slug: run.agent_slug,
    trigger: run.trigger,
    output_text_len: output_text.length,
    is_seed,
    has_pending_proposals: hasProposals,
  });
  if (!gate.ok) {
    await markDistilled();
    return { written: 0, skipped: 0 };
  }

  if (useTranscript) {
    const junk = junkReasonForRunOutput(output_text);
    if (junk) {
      await recordWrites(run.tenant_id, [
        {
          source: "auto_distill_agent_run",
          action: "junk",
          run_id: run.id,
          candidate_body: output_text.slice(0, 1000),
          reason: `junk:${junk}`,
        },
      ]);
      if (!hasProposals) {
        await markDistilled();
        return { written: 0, skipped: 1 };
      }
      useTranscript = false;
    }
  }

  if (useTranscript) {
    const { data: ledgerCount, error: ledgerErr } = await svc.rpc(
      "distill_budget_increment",
      { p_tenant_id: run.tenant_id },
    );
    if (ledgerErr) {
      console.warn(
        `[distill-agent-run] ledger increment failed for tenant ${run.tenant_id}: ${ledgerErr.message}`,
      );
    } else if (typeof ledgerCount === "number" && ledgerCount > MAX_DISTILL_PER_TENANT_PER_DAY) {
      if (!hasProposals) {
        await markDistilled();
        return { written: 0, skipped: 0 };
      }
      useTranscript = false;
    }
  }

  const { data: reasoningData } = !useTranscript
    ? { data: [] }
    : await svc
        .from("thread_event")
        .select("body, created_at")
        .eq("agent_run_id", run.id)
        .eq("kind", "reasoning")
        .order("created_at", { ascending: false })
        .limit(MAX_REASONING_ROWS);
  const reasoning = ((reasoningData ?? []) as ReasoningEventRow[])
    .filter((r) => !runPhaseOf((r.body as { text?: unknown } | null)?.text))
    .reverse();

  const reasoningRaw =
    reasoning.length > 0
      ? reasoning
          .map((r, i) => `### Reasoning step ${i + 1}\n${(r.body?.text ?? "").slice(0, 800)}`)
          .join("\n\n")
      : "(no intermediate reasoning recorded)";

  const wrappedReasoning = renderUntrustedBlock("agent_reasoning", reasoningRaw);
  const wrappedOutput = renderUntrustedBlock("agent_output", output_text);

  const userPrompt = useTranscript
    ? [
        `## Agent: ${run.agent_slug}`,
        `## Trigger: ${run.trigger}`,
        "",
        "## What the agent did (reasoning trace, most-recent last)",
        wrappedReasoning,
        "",
        "## Final output",
        wrappedOutput,
      ]
        .join("\n")
        .slice(0, MAX_USER_PROMPT_CHARS)
    : [`## Agent: ${run.agent_slug}`, `## Trigger: ${run.trigger}`, "", PROPOSALS_ONLY_NOTE].join("\n");

  const result = await runDistill({
    tenant_id: run.tenant_id,
    source: "auto_distill_agent_run",
    source_ref: run.id,
    systemPrompt: AGENT_RUN_DISTILL_SYSTEM_PROMPT,
    userPrompt,
    baseTags: [`agent:${run.agent_slug}`, `trigger:${run.trigger}`],
    dropUnverifiedAbsenceFacts: run.agent_slug === "engineer",
    liveConnectors: await liveConnectorsForTenant(svc, run.tenant_id),
    toolCalls: (run as { tool_calls?: unknown }).tool_calls as
      | ToolCallTrace[]
      | undefined,
    gate: {
      ceiling: 2,
      queryText: useTranscript ? output_text.slice(0, 4000) : "",
      run_id: run.id,
    },
    proposals: { agent_slug: run.agent_slug, items: proposals },
  });

  if (result.failed > 0) {
    throw new Error(`distill-agent-run: ${result.failed} note write(s) failed for run ${run.id}`);
  }

  if (!run.distilled_at) await markDistilled();

  return { written: result.written, skipped: result.skipped };
}

export const distillAgentRunFn = inngest.createFunction(
  { id: "distill-agent-run", retries: 1, concurrency: distillConcurrency("distill-agent-run-global") },
  { event: "agent.run.distillable" },
  async ({ event, step, logger }) => {
    const run_id = event.data.run_id as string;
    if (!run_id) {
      logger.warn("[distill-agent-run] missing run_id; no-op");
      return { written: 0, skipped: 0 };
    }
    const res = await step.run("distill", () => distillAgentRun(run_id));
    logger.info(`distill-agent-run ${run_id}: written=${res.written} skipped=${res.skipped}`);
    return res;
  },
);
