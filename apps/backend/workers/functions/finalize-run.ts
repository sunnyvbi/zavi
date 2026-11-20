
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { persistTerminal, postRunDistill } from "@/services/agents/runner";
import { recordAgentTake } from "@/services/memory/takes-service";
import { postProcessors } from "@/agents/index";
import {
  competitorSnapshotPostProcess,
  isCompetitorIntelWeeklyPayload,
} from "@/agents/research/persist-snapshot";
import { persistResearchEvidence } from "@/agents/research/persist-evidence";
import { notifyThreadOwner } from "@/services/notifications/push-fanout";
import { loadAgentDefinition } from "@/services/agents/registry";
import { writeCronRunSummary } from "@/services/agents/cron-summary";
import { recordPredictions } from "@/services/agents/predictions";
import type {
  AgentContext,
  DispatcherResult,
  EmitProgress,
} from "@/services/agents/types";
import { REACTIVE_AGENT_SLUGS } from "./run-agent";
import { flushRunTiming, markRunTiming, planBuildFields } from "@/services/agents/run-timing";
import { logEvent } from "@/services/logging/logEvent";
import { resultTerminalStatus, type CompletionAssessment } from "@/services/agents/run-completion";

export type FinalizeStepLike = {
  run: (id: string, fn: () => Promise<unknown>) => Promise<unknown>;
  sendEvent: (
    id: string,
    payload: { name: string; data: Record<string, unknown> },
  ) => Promise<unknown>;
};

export type FinalizeRunInput = {
  run_id: string;
  tenant_id: string;
  agent_slug: string;
  trigger: string;
  model: string;
  result: DispatcherResult;
  payload: unknown;
  preview?: boolean;
};

export type FinalizeRunDeps = {
  step?: FinalizeStepLike;
  emitWorker: EmitProgress;
  rebuildContext: () => Promise<AgentContext>;
};

export async function finalizeRun(
  input: FinalizeRunInput,
  deps: FinalizeRunDeps,
): Promise<{ run_id: string; status: "success" | "parse_failed" | "failed" }> {
  const { run_id, tenant_id, agent_slug, trigger, model, result, payload } =
    input;
  const { emitWorker } = deps;

  const runStep = (id: string, fn: () => Promise<unknown>) =>
    deps.step ? deps.step.run(id, fn) : fn();
  const bestEffortStep = async (id: string, fn: () => Promise<unknown>) => {
    const warn = (e: unknown) =>
      console.warn(`run-agent: ${id} failed for ${run_id}: ${(e as Error).message}`);
    if (!deps.step) {
      void fn().catch(warn);
      return;
    }
    try {
      await deps.step.run(id, fn);
    } catch (e) {
      warn(e);
    }
  };
  const sendStep = (
    id: string,
    eventPayload: { name: string; data: Record<string, unknown> },
  ) =>
    deps.step
      ? deps.step.sendEvent(id, eventPayload)
      :
        inngest.send(eventPayload as Parameters<typeof inngest.send>[0]);

  markRunTiming(run_id, "finalize_start");
  if (agent_slug === "growth-lead" && trigger !== "chat") {
    try {
      await runStep("post-run-growth", async () => {
        const ppCtx = await deps.rebuildContext();
        await postProcessors["growth-lead"]?.(ppCtx, result, payload);
      });
    } catch (e) {
      console.warn(
        `run-agent: growth post-run failed for ${run_id}: ${(e as Error).message}`,
      );
    }
  }

  if (
    agent_slug === "research" &&
    trigger !== "chat" &&
    isCompetitorIntelWeeklyPayload(payload)
  ) {
    try {
      await runStep("post-run-competitor-snapshot", async () => {
        const ppCtx = await deps.rebuildContext();
        await competitorSnapshotPostProcess(ppCtx, result, payload);
      });
    } catch (e) {
      console.warn(
        `run-agent: competitor-snapshot post-run failed for ${run_id}: ${(e as Error).message}`,
      );
    }
  }

  if (agent_slug === "research" && result.parse_ok) {
    try {
      await runStep("post-run-research-evidence", () =>
        persistResearchEvidence({ tenant_id, run_id, payload, result }),
      );
    } catch (e) {
      console.warn(
        `run-agent: research evidence persist failed for ${run_id}: ${(e as Error).message}`,
      );
    }
  }

  markRunTiming(run_id, "post_run_steps_done");
  const completion = await runStep("persist-success", () =>
    persistTerminal(
      run_id,
      agent_slug,
      result,
      null,
      model,
      payload,
      trigger,
      tenant_id,
    ),
  );
  const status = resultTerminalStatus(result.parse_ok, (completion ?? "unknown") as CompletionAssessment);
  markRunTiming(run_id, "persisted");
  for (const stage of ["persisted", "completed"] as const) {
    try {
      await runStep(`progress-${stage}`, () => stage === "completed"
        ? emitWorker(stage, { code: status })
        : emitWorker(stage));
    } catch (e) {
      console.warn(`run-agent: ${stage} progress failed for ${run_id} (terminal status retained): ${(e as Error).message}`);
    }
  }
  await flushRunTiming(run_id, { agent_slug, trigger, parse_ok: result.parse_ok, outcome: status === "success" ? "ok" : status, ...planBuildFields(payload) }, tenant_id);

  try {
    const agentDefForFlag = await loadAgentDefinition(agent_slug, tenant_id);
    if (!input.preview && agentDefForFlag?.metadata_praxis.memory_layer !== false) {
      await runStep("post-run-distill", () =>
        postRunDistill(tenant_id, agent_slug, result),
      );
    }
  } catch (e) {
    console.warn(
      `run-agent: post-run distill failed for ${run_id}: ${(e as Error).message}`,
    );
  }

  try {
    await runStep("post-run-record-take", () =>
      recordAgentTake(tenant_id, agent_slug, run_id, result),
    );
  } catch (e) {
    console.warn(
      `run-agent: post-run record-take failed for ${run_id}: ${(e as Error).message}`,
    );
  }

  if (result.parse_ok && trigger === "chat") {
    const threadId =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { thread_id?: unknown }).thread_id === "string"
        ? ((payload as { thread_id?: string }).thread_id as string)
        : null;
    await bestEffortStep("mobile-push-chat-reply", () =>
      notifyThreadOwner({
        tenant_id,
        agent_slug,
        thread_id: threadId,
        title: "Zavi replied",
        body: "Tap to read the reply.",
      }),
    );
  }

  if (
    REACTIVE_AGENT_SLUGS.has(agent_slug) &&
    result.parse_ok &&
    result.output_text &&
    result.output_text.length > 0
  ) {
    await bestEffortStep("record-predictions", () =>
      recordPredictions({
        tenant_id,
        agent_run_id: run_id,
        agent_slug,
        output_text: result.output_text as string,
      }),
    );
  }

  if (trigger === "cron") {
    try {
      await runStep("cron-summary", async () => {
        const { data: row } = await serviceClient()
          .from("agent_runs")
          .select("cost_usd")
          .eq("id", run_id)
          .maybeSingle();
        const costUsd = (row as { cost_usd?: number } | null)?.cost_usd ?? null;
        await writeCronRunSummary({
          tenant_id,
          agent_slug,
          run_id,
          status,
          cost_usd: costUsd,
          summary_text:
            typeof result.output_text === "string"
              ? result.output_text.slice(0, 200)
              : "",
        });
      });
    } catch (e) {
      console.warn(
        `run-agent: cron summary write failed for ${run_id}: ${(e as Error).message}`,
      );
    }
  }

  const completedEvent = {
    name: "agent.run.completed",
    data: {
      run_id,
      tenant_id,
      agent_slug,
      status,
    },
  };
  try {
    await sendStep("emit-completed", completedEvent);
  } catch {
    try {
      await sendStep("emit-completed-retry", completedEvent);
    } catch (e) {
      try {
        await runStep("log-emit-completed-failed", () =>
          logEvent({
            level: "warn",
            source: "worker.run-agent",
            code: "emit_completed_failed",
            tenant_id,
            run_id,
            error: e,
            meta: { agent_slug },
          }),
        );
      } catch (logError) {
        console.warn(`run-agent: completion warning failed for ${run_id}: ${(logError as Error).message}`);
      }
    }
  }

  try {
    await sendStep("emit-terminal", {
      name: "agent.run.terminal",
      data: { run_id },
    });
  } catch (e) {
    console.warn(
      `run-agent: agent.run.terminal emit failed for ${run_id} (trace skipped, run still success): ${(e as Error).message}`,
    );
  }

  return { run_id, status };
}
