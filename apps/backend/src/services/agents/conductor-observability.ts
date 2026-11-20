import { logEvent } from "@/services/logging/logEvent";
import { durationMs } from "./build-failure";
import type { ConductorNode, ConductorTickResult } from "./conductor";

const stageOf = (node: ConductorNode | undefined): string => {
  const stage = node?.payload?.stage;
  return typeof stage === "string" && stage ? stage : "unknown";
};

const short = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 240);

const stageStartedAt = (node: ConductorNode): string | null | undefined => {
  const enqueued = node.payload?.deploy_enqueued_at;
  if (stageOf(node) === "deploy" && typeof enqueued === "number" && Number.isFinite(enqueued)) {
    return new Date(enqueued).toISOString();
  }
  return node.started_at;
};

export function stageTimings(
  graph: ConductorNode[],
): { stages: Array<{ node: ConductorNode; stage: string; ms: number }>; total_ms: number | null } {
  const stages: Array<{ node: ConductorNode; stage: string; ms: number }> = [];
  let first: number | null = null;
  let last: number | null = null;
  for (const node of graph) {
    const startedAt = stageStartedAt(node);
    const ms = durationMs(startedAt, node.finished_at);
    if (ms === null) continue;
    stages.push({ node, stage: stageOf(node), ms });
    const start = Date.parse(startedAt as string);
    const finish = Date.parse(node.finished_at as string);
    first = first === null ? start : Math.min(first, start);
    last = last === null ? finish : Math.max(last, finish);
  }
  return { stages, total_ms: first === null || last === null ? null : Math.max(0, last - first) };
}

async function logStageTimings(
  tenant_id: string,
  conductor_run_id: string,
  graph: ConductorNode[],
): Promise<void> {
  const { stages, total_ms } = stageTimings(graph);
  if (stages.length === 0) return;
  await Promise.all([
    ...stages.map(({ node, stage, ms }) =>
      logEvent({
        level: "info",
        source: "conductor.build",
        code: "stage_timing",
        tenant_id,
        run_id: conductor_run_id,
        message: `${stage}: ${ms}ms`,
        meta: {
          build_stage: stage,
          node_status: node.status,
          node_id: node.id,
          run_id_ref: node.child_run_id ?? undefined,
          agent_slug: node.target_agent_slug,
          ms,
          retry_count: node.repair_attempts ?? node.acceptance_attempts ?? 0,
        },
      }),
    ),
    logEvent({
      level: "info",
      source: "conductor.build",
      code: "build_timing",
      tenant_id,
      run_id: conductor_run_id,
      message: short(stages.map(({ stage, ms }) => `${stage}=${ms}ms`).join(" ")),
      meta: { build_stage: "total", ms: total_ms ?? undefined },
    }),
  ]);
}

export async function logBuildTick(input: {
  tenant_id: string;
  conductor_run_id: string;
  result: ConductorTickResult;
  graph: ConductorNode[];
}): Promise<void> {
  try {
    const { result, graph } = input;
    if (result.action === "noop" || result.action === "waiting" || result.action === "class_read_error") {
      return;
    }
    const resultNode = "node_id" in result
      ? graph.find((node) => node.id === result.node_id)
      : undefined;
    const finishedNode = [...graph].reverse().find((node) => node.finished_at);
    const node = resultNode ?? finishedNode;
    const retryCount = node?.repair_attempts ?? node?.acceptance_attempts ?? 0;
    const failureReason = node?.error ?? node?.last_failure_signal ?? null;
    const failed = node?.status === "failed" || result.action === "dispatch_failed" ||
      result.action === "completed_after_repair_exhausted" ||
      result.action === "completed_provider_capacity" ||
      result.action === "completed_app_database_setup" ||
      result.action === "completed_platform_config_error";
    const status = node?.status ?? (result.action === "completed" ? result.final : result.action);
    const message = failureReason
      ? `${stageOf(node)}: ${short(failureReason)}`
      : `${stageOf(node)}: ${status}`;

    await logEvent({
      level: failed ? "error" : result.action === "halted" || result.action === "class_over_cap" ? "warn" : "info",
      source: "conductor.build",
      code: result.action,
      tenant_id: input.tenant_id,
      run_id: input.conductor_run_id,
      message,
      meta: {
        build_stage: stageOf(node),
        node_status: status,
        node_id: node?.id,
        run_id_ref: node?.child_run_id ?? undefined,
        agent_slug: node?.target_agent_slug,
        ms: (node ? durationMs(stageStartedAt(node), node.finished_at) : null) ?? undefined,
        failure_class: node?.failure_class ?? undefined,
        retry_count: retryCount,
      },
    });
    if (result.action.startsWith("completed")) {
      await logStageTimings(input.tenant_id, input.conductor_run_id, graph);
    }
  } catch {
  }
}
