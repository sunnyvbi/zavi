import {
  BUILD_INTERNAL_FAILURE,
  BUILD_STAGE_RETRYING,
  founderBuildFailure,
  type FounderBuildFailureCode,
} from "@zavi/shared";
import { classifyAppDatabaseError, classifyProviderError, type BuildFailureClass } from "./conductor";
import { builderPolicyRefusalCopy } from "./run-failure-code";

export type BuildStageNode = {
  id?: string | null;
  status?: string | null;
  target_agent_slug?: string | null;
  child_run_id?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
  last_failure_signal?: string | null;
  failure_class?: BuildFailureClass | null;
  repair_attempts?: number | null;
  site_repair_attempts?: number | null;
  payload?: { stage?: string; refine_mode?: boolean } | null;
};

export type BuildChildRun = {
  id: string;
  agent_slug?: string | null;
  status?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  last_progress_at?: string | null;
  error?: string | null;
  parse_error?: string | null;
  output_text?: string | null;
};

export type BuildFailure = {
  class: BuildFailureClass;
  message: string;
  stage: string | null;
  run_id: string | null;
  agent: string | null;
  retry_count: number;
};

export const BUILD_STATUS_ERROR_MAX_CHARS = 1000;

const text = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean ? clean.slice(0, BUILD_STATUS_ERROR_MAX_CHARS) : null;
};

export const boundedBuildError = (value: unknown): string | null => text(value);

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

export function stageRetryCount(node: BuildStageNode | null | undefined): number {
  return Math.max(count(node?.repair_attempts), count(node?.site_repair_attempts));
}

export function nodeFailureText(node: BuildStageNode): string | null {
  return text(node.error) ?? (node.status === "failed" ? text(node.last_failure_signal) : null);
}

export const isFailedChildStatus = (status: string | null | undefined): boolean =>
  status === "failed" || status === "parse_failed" || status === "dispatch_error";

export function childFailureMessage(child: BuildChildRun | null | undefined): string | null {
  return text(child?.error) ?? text(child?.parse_error) ?? text(child?.output_text);
}

export function durationMs(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
): number | null {
  if (!startedAt || !finishedAt) return null;
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return null;
  return Math.max(0, finish - start);
}

export function classifyBuildFailure(
  message: string,
  explicit?: BuildFailureClass | null,
): BuildFailureClass {
  if (explicit) return explicit;
  if (classifyAppDatabaseError(message).app_database) return "app_database_setup";
  if (classifyProviderError(message).transient) return "provider_capacity";
  return "stage_failed";
}

export function summarizeBuildFailure(input: {
  runStatus: string | null | undefined;
  graph: BuildStageNode[];
  children: Map<string, BuildChildRun>;
  cancelReason?: "stale_slot_reap" | "user_cancel" | null;
}): BuildFailure | null {
  if (input.cancelReason) {
    const stale = input.cancelReason === "stale_slot_reap";
    return {
      class: stale ? "stale_reaped" : "user_cancelled",
      message: stale
        ? "Build stopped after the active stage stopped reporting progress."
        : "Build was stopped by the user.",
      stage: null,
      run_id: null,
      agent: null,
      retry_count: 0,
    };
  }

  const candidates = input.graph.filter((node) => {
    const child = node.child_run_id ? input.children.get(node.child_run_id) : null;
    return node.status === "failed" || !!nodeFailureText(node) || isFailedChildStatus(child?.status);
  });
  const node = candidates.at(-1);
  if (node) {
    const child = node.child_run_id ? input.children.get(node.child_run_id) : null;
    const stage = text(node.payload?.stage);
    const message = nodeFailureText(node) ?? childFailureMessage(child) ??
      `Stage "${stage ?? "unknown"}" failed.`;
    return {
      class: classifyBuildFailure(message, node.failure_class),
      message,
      stage,
      run_id: node.child_run_id ?? null,
      agent: text(node.target_agent_slug) ?? text(child?.agent_slug),
      retry_count: stageRetryCount(node),
    };
  }

  if (input.runStatus === "halted") {
    return {
      class: "budget_halted",
      message: "Build stopped because its spend limit was reached.",
      stage: null,
      run_id: null,
      agent: null,
      retry_count: 0,
    };
  }
  if (input.runStatus === "failed") {
    return {
      class: "unknown",
      message: "Build failed before a detailed stage error was recorded.",
      stage: null,
      run_id: null,
      agent: null,
      retry_count: 0,
    };
  }
  return null;
}

const COMPLETED_STAGE: ReadonlySet<string> = new Set(["done", "success", "succeeded"]);

export type FounderBuildFailureView = {
  class: BuildFailureClass;
  code: FounderBuildFailureCode;
  message: string;
  stage: string | null;
  retry_count: number;
};

export function founderFailureView(
  failure: BuildFailure | null,
  stages: ReadonlyArray<{ status?: string | null }>,
): FounderBuildFailureView | null {
  if (!failure) return null;
  const startedWork = stages.some((s) => COMPLETED_STAGE.has(s.status ?? ""));
  const founder = founderBuildFailure(failure, {
    startedWork,
    authoredCopy: builderPolicyRefusalCopy(failure.message),
  }) ?? {
    code: "internal" as const,
    message: BUILD_INTERNAL_FAILURE,
  };
  return {
    class: failure.class,
    code: founder.code,
    message: founder.message,
    stage: failure.stage,
    retry_count: failure.retry_count,
  };
}

export function founderStageError(
  rawError: string | null,
  status: string,
  failureClass: BuildFailureClass | null | undefined,
  runStopped = false,
): string | null {
  if (!rawError) return null;
  if (COMPLETED_STAGE.has(status) || status === "skipped") return null;
  if (status !== "failed" && !runStopped) return BUILD_STAGE_RETRYING;
  return (
    founderBuildFailure(
      { class: failureClass ?? classifyBuildFailure(rawError), message: rawError },
      { authoredCopy: builderPolicyRefusalCopy(rawError) },
    )?.message ?? BUILD_INTERNAL_FAILURE
  );
}
