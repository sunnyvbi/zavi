
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { loadMemoryDocs } from "@/services/memory/loader";
import { ctoShipPrPayloadSchema } from "@/agents/engineer/input-contract";
import {
  runPlanCritic,
  type PlanBody,
  type PlanCriticVerdict,
} from "@/services/critic/plan-critic";
import { emitThreadEvent } from "@/services/agents/thread-event";

const STAGE_CONTEXT_FALLBACK =
  "Stage unknown — operator has not filled the company-context memory anchor yet. Default to under-engineer (low risk).";

type HydratedContext = {
  tenant_id: string;
  agent_slug: string;
  thread_id: string | null;
  task_description: string;
  context_summary: string;
  stage_context: string;
};

export const planCriticFn = inngest.createFunction(
  { id: "plan-critic", retries: 2 },
  { event: "agent.plan-critic-needed" },
  async ({ event, step }) => {
    const { run_id, plan } = event.data as {
      run_id: string;
      tenant_id: string;
      agent_slug: string;
      plan: PlanBody;
    };

    const hydrated = await step.run(
      `plan-critic-hydrate-${run_id}`,
      async (): Promise<HydratedContext> => {
        const { data: row, error } = await serviceClient()
          .from("agent_runs")
          .select("tenant_id, agent_slug, payload")
          .eq("id", run_id)
          .single();
        if (error || !row) {
          throw new Error(
            `plan-critic hydrate failed for run=${run_id}: ${error?.message ?? "row not found"}`,
          );
        }
        if (row.agent_slug !== "engineer") {
          throw new Error(
            `plan-critic skipped: agent_slug=${row.agent_slug} (expected engineer)`,
          );
        }
        const parsed = ctoShipPrPayloadSchema.safeParse(row.payload);
        const task_description = parsed.success
          ? parsed.data.task_description
          : `[payload did not match CtoShipPrPayload contract; raw preview]\n${JSON.stringify(row.payload).slice(0, 2000)}`;
        const context_summary = parsed.success ? parsed.data.context_summary : "";

        const payloadObj = (row.payload ?? null) as Record<string, unknown> | null;
        const payloadThreadId = payloadObj?.thread_id;
        const thread_id =
          typeof payloadThreadId === "string" ? payloadThreadId : null;

        const memory = await loadMemoryDocs(row.tenant_id);
        const company = memory.company;
        const stage_context =
          company && company.trim().length > 0 ? company : STAGE_CONTEXT_FALLBACK;

        return {
          tenant_id: row.tenant_id,
          agent_slug: row.agent_slug,
          thread_id,
          task_description,
          context_summary,
          stage_context,
        };
      },
    );

    const verdict: PlanCriticVerdict = await step.run(
      `plan-critic-run-${run_id}`,
      () =>
        runPlanCritic({
          plan,
          task_description: hydrated.task_description,
          context_summary: hydrated.context_summary,
          stage_context: hydrated.stage_context,
        }),
    );

    await step.run(`plan-critic-emit-${run_id}`, () =>
      emitThreadEvent({
        agent_run_id: run_id,
        agent_slug: hydrated.agent_slug,
        tenant_id: hydrated.tenant_id,
        thread_id: hydrated.thread_id,
        kind: "plan_critic_verdict",
        body: verdict,
      }),
    );

    return {
      ok: true,
      verdict: verdict.verdict,
      top_severity: verdict.top_severity,
      cost_usd: verdict.cost_usd,
    };
  },
);
