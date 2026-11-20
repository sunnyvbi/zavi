
import { capCountedChangeUsd, evaluateBudgetCap, type Cap } from "./_cap-evaluator";

export const DAILY_AGGREGATE_UNREADABLE = Number.MAX_SAFE_INTEGER;

export function aggregateIsMeasured(today_total_change_usd: number): boolean {
  return (
    Number.isFinite(today_total_change_usd) &&
    today_total_change_usd < DAILY_AGGREGATE_UNREADABLE
  );
}

export type CapState = {
  enabled: boolean;
  max_daily_budget_usd: number | null;
  max_pct_change_per_run: number | null;
  max_daily_total_change_usd: number | null;
};

export type BudgetSimulation = {
  kind: "budget";
  before_daily_budget_usd: number;
  after_daily_budget_usd: number;
  delta_usd: number;
  pct_change: number | null;
  today_aggregate_after_usd: number | null;
  within: boolean;
  reason: string | null;
  cap_state: CapState | null;
};

export type StatusSimulation = {
  kind: "status";
  object_id: string;
  level: "campaign" | "adset";
  before_status: "ACTIVE" | "PAUSED";
  after_status: "ACTIVE" | "PAUSED";
  reopens_spend: boolean;
};

export type CreateSimulation = {
  kind: "create";
  campaign_id: string;
  name: string;
  daily_budget_usd: number;
  created_status: "PAUSED";
  today_aggregate_after_usd: number | null;
  within: boolean;
  reason: string | null;
  cap_state: CapState | null;
};

function capState(cap: Cap | null): CapState | null {
  if (cap == null) return null;
  return {
    enabled: cap.enabled,
    max_daily_budget_usd: cap.max_daily_budget_usd,
    max_pct_change_per_run: cap.max_pct_change_per_run,
    max_daily_total_change_usd: cap.max_daily_total_change_usd,
  };
}

function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

function aggregateAfter(today_total_change_usd: number, added: number): number | null {
  if (!aggregateIsMeasured(today_total_change_usd)) return null;
  return cents(today_total_change_usd + added);
}

export function simulateBudgetWrite(input: {
  current_daily_budget_usd: number;
  proposed_daily_budget_usd: number;
  today_total_change_usd: number;
  cap: Cap | null;
}): BudgetSimulation {
  const { current_daily_budget_usd, proposed_daily_budget_usd, today_total_change_usd, cap } = input;

  const delta = proposed_daily_budget_usd - current_daily_budget_usd;
  const pct =
    current_daily_budget_usd > 0 ? delta / current_daily_budget_usd : null;

  const evalRes = evaluateBudgetCap({
    proposed_daily_budget_usd,
    current_daily_budget_usd,
    today_total_change_usd,
    cap,
  });

  return {
    kind: "budget",
    before_daily_budget_usd: cents(current_daily_budget_usd),
    after_daily_budget_usd: cents(proposed_daily_budget_usd),
    delta_usd: cents(delta),
    pct_change: pct == null ? null : cents(pct),
    today_aggregate_after_usd: aggregateAfter(today_total_change_usd, capCountedChangeUsd(proposed_daily_budget_usd, current_daily_budget_usd)),
    within: evalRes.within,
    reason: evalRes.reason ?? null,
    cap_state: capState(cap),
  };
}

export function simulateStatusWrite(input: {
  object_id: string;
  level: "campaign" | "adset";
  current_status: "ACTIVE" | "PAUSED";
  target_status: "ACTIVE" | "PAUSED";
}): StatusSimulation {
  const { object_id, level, current_status, target_status } = input;
  return {
    kind: "status",
    object_id,
    level,
    before_status: current_status,
    after_status: target_status,
    reopens_spend: current_status === "PAUSED" && target_status === "ACTIVE",
  };
}

export function simulateCreateWrite(input: {
  campaign_id: string;
  name: string;
  daily_budget_usd: number;
  today_total_change_usd: number;
  cap: Cap | null;
}): CreateSimulation {
  const { campaign_id, name, daily_budget_usd, today_total_change_usd, cap } = input;

  const evalRes = evaluateBudgetCap({
    proposed_daily_budget_usd: daily_budget_usd,
    current_daily_budget_usd: 0,
    today_total_change_usd,
    cap,
  });

  return {
    kind: "create",
    campaign_id,
    name,
    daily_budget_usd: cents(daily_budget_usd),
    created_status: "PAUSED",
    today_aggregate_after_usd: aggregateAfter(today_total_change_usd, daily_budget_usd),
    within: evalRes.within,
    reason: evalRes.reason ?? null,
    cap_state: capState(cap),
  };
}
