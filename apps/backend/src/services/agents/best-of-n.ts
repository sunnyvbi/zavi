
import type {
  AgentContext,
  AgentCostClass,
  DispatcherResult,
} from "./types";
import { scoreAtoms } from "./eval/atom-scorer";
import { estimateRunCost, consumeBudgetOrReject, resolveDailyCapUsd, utcDay } from "./budget";
import {
  resolveBestOfNPolicy,
  type BestOfNPolicy,
} from "./_best-of-n-flag-check";

export type BestOfNOutcome =
  | "ran"
  | "disabled"
  | "best_of_n_skipped_budget";

export interface BestOfNPlan {
  n: number;
  extraReservationUsd: number;
  outcome: BestOfNOutcome;
}

const DRAFT_WRITE_FRAGMENTS: readonly string[] = [
  "action",
  "propose",
  "write",
  "create",
  "update",
  "delete",
  "set_status",
  "post_message",
  "send_message",
  "send",
  "refund",
  "charge",
  "submit",
  "transition",
  "comment",
  "apply",
];

export function isDraftDeniedTool(toolName: string): boolean {
  const raw = String(toolName ?? "").toLowerCase();
  const name = raw.startsWith("mcp__")
    ? raw.replace(/^mcp__(?:[^_]+(?:_[^_]+)*__)?/, "")
    : raw;
  return DRAFT_WRITE_FRAGMENTS.some((frag) => name.includes(frag));
}

export function estimateCandidateCostUsd(costClass: AgentCostClass): number {
  return estimateRunCost(costClass);
}

export function planBestOfN(args: {
  policy: BestOfNPolicy;
  candidateCostUsd: number;
  nightlyConsumed: number;
}): BestOfNPlan {
  const { policy, candidateCostUsd, nightlyConsumed } = args;

  if (!policy.enabled || policy.kill || policy.n <= 1) {
    return { n: 1, extraReservationUsd: 0, outcome: "disabled" };
  }

  let extras = policy.n - 1;
  if (policy.nightlyMaxCandidates > 0) {
    const remaining = policy.nightlyMaxCandidates - Math.max(0, nightlyConsumed);
    if (remaining <= 0) {
      return { n: 1, extraReservationUsd: 0, outcome: "disabled" };
    }
    if (extras > remaining) extras = remaining;
  }

  if (extras <= 0) {
    return { n: 1, extraReservationUsd: 0, outcome: "disabled" };
  }

  return {
    n: extras + 1,
    extraReservationUsd: extras * candidateCostUsd,
    outcome: "ran",
  };
}

export interface CandidateScore {
  index: number;
  grade: number;
  surviving: number;
  total: number;
}

export function selectBest(candidates: readonly DispatcherResult[]): {
  winnerIndex: number;
  scores: CandidateScore[];
} {
  const scores: CandidateScore[] = candidates.map((c, index) => {
    const s = scoreAtoms({
      outputText: c.output_text ?? "",
      toolCalls: c.tool_calls ?? [],
      decisionBody: c.parsed,
    });
    return { index, grade: s.grade, surviving: s.surviving, total: s.total };
  });

  let winnerIndex = 0;
  let best = scores.length > 0 ? scores[0].grade : 0;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i].grade > best) {
      best = scores[i].grade;
      winnerIndex = i;
    }
  }
  return { winnerIndex, scores };
}

export interface RunBestOfNDeps {
  runOnce: (ctx: AgentContext, payload: unknown) => Promise<DispatcherResult>;
  makeDraftCtx: (ctx: AgentContext) => AgentContext;
  readNightlyConsumed: (tenantId: string) => Promise<number>;
  emitTelemetry?: (ev: {
    code: string;
    outcome: BestOfNOutcome;
    n: number;
    winner_index?: number;
  }) => void;
}

export async function runBestOfN(
  ctx: AgentContext,
  payload: unknown,
  deps: RunBestOfNDeps,
  policyOverride?: BestOfNPolicy,
): Promise<DispatcherResult> {
  const policy = policyOverride ?? (await resolveBestOfNPolicy());

  if (!policy.enabled || policy.kill || policy.n <= 1) {
    return deps.runOnce(ctx, payload);
  }

  const candidateCostUsd = estimateCandidateCostUsd(
    ctx.agent.metadata_praxis.cost_class,
  );
  const nightlyConsumed = await safeNightly(deps.readNightlyConsumed, ctx.tenant_id);
  const plan = planBestOfN({ policy, candidateCostUsd, nightlyConsumed });

  if (plan.n <= 1) {
    deps.emitTelemetry?.({ code: "best_of_n_disabled_cap", outcome: "disabled", n: 1 });
    return deps.runOnce(ctx, payload);
  }

  const reserved = await reserveExtraBudget(ctx.tenant_id, plan.extraReservationUsd);
  if (!reserved) {
    deps.emitTelemetry?.({
      code: "best_of_n_skipped_budget",
      outcome: "best_of_n_skipped_budget",
      n: 1,
    });
    return deps.runOnce(ctx, payload);
  }

  const draftCtx = deps.makeDraftCtx(ctx);
  const candidates: DispatcherResult[] = [];
  candidates.push(await deps.runOnce(ctx, payload));
  for (let i = 1; i < plan.n; i++) {
    candidates.push(await deps.runOnce(draftCtx, payload));
  }

  const { winnerIndex, scores } = selectBest(candidates);
  deps.emitTelemetry?.({
    code: "best_of_n_ran",
    outcome: "ran",
    n: plan.n,
    winner_index: winnerIndex,
  });

  if (winnerIndex === 0) {
    return candidates[0];
  }

  void scores;
  return deps.runOnce(ctx, payload);
}

async function safeNightly(
  read: (t: string) => Promise<number>,
  tenantId: string,
): Promise<number> {
  try {
    const n = await read(tenantId);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function reserveExtraBudget(
  tenantId: string,
  extraUsd: number,
): Promise<boolean> {
  if (!(extraUsd > 0)) return true;
  try {
    const dailyCap = await resolveDailyCapUsd(tenantId);
    return await consumeBudgetOrReject({
      tenant_id: tenantId,
      estimate: extraUsd,
      dailyCap,
      day: utcDay(),
    });
  } catch {
    return false;
  }
}
