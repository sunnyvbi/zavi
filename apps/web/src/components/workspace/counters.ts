
export type StatusCounters = {
  drift_pct: number;
  cost_today_usd: number;
  active_runs: number;
  approvals_pending: number;
  credits_remaining: number | null;
  credits_enforced: boolean;
  included_allowance: number | null;
  credits_total: number | null;
};

export const EMPTY_COUNTERS: StatusCounters = {
  drift_pct: 0,
  cost_today_usd: 0,
  active_runs: 0,
  approvals_pending: 0,
  credits_remaining: null,
  credits_enforced: false,
  included_allowance: null,
  credits_total: null,
};

export function num(x: unknown, d = 0): number {
  return typeof x === "number" && Number.isFinite(x) ? x : d;
}

export function normalizeCounters(
  raw: unknown,
  prev: StatusCounters = EMPTY_COUNTERS,
): StatusCounters {
  if (!raw || typeof raw !== "object") return prev;
  const o = raw as Record<string, unknown>;
  return {
    drift_pct: num(o.drift_pct, prev.drift_pct),
    cost_today_usd: num(o.cost_today_usd, prev.cost_today_usd),
    active_runs: num(o.active_runs, prev.active_runs),
    approvals_pending: num(o.approvals_pending, prev.approvals_pending),
    credits_remaining:
      typeof o.credits_remaining === "number" && Number.isFinite(o.credits_remaining)
        ? o.credits_remaining
        : o.credits_remaining === null
          ? null
          : prev.credits_remaining,
    credits_enforced: o.credits_enforced === true,
    included_allowance:
      typeof o.included_allowance === "number" && Number.isFinite(o.included_allowance)
        ? o.included_allowance
        : o.included_allowance === null
          ? null
          : prev.included_allowance,
    credits_total:
      typeof o.credits_total === "number" && Number.isFinite(o.credits_total)
        ? o.credits_total
        : o.credits_total === null
          ? null
          : prev.credits_total,
  };
}
