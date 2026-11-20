
export const FAILURE_STATUSES = new Set(["failed", "parse_failed", "dispatch_error"]);
export const TERMINAL_STATUSES = new Set([
  "failed",
  "parse_failed",
  "dispatch_error",
  "success",
  "done",
]);

export const DEFAULT_RATE_THRESHOLD = 0.5;
export const DEFAULT_MIN_TERMINAL_PER_TENANT = 5;
export const DEFAULT_MIN_TERMINAL_GLOBAL = 20;

export type RunRow = { tenant_id: string | null; status: string | null };

export type TenantFailureStat = {
  tenant_id: string;
  terminal: number;
  failed: number;
  rate: number;
  parse_failed: number;
};

export type FailureRateReport = {
  global: { terminal: number; failed: number; rate: number; parse_failed: number };
  perTenant: TenantFailureStat[];
  alarmedTenants: TenantFailureStat[];
  globalAlarmed: boolean;
};

export type ThresholdOpts = {
  rateThreshold?: number;
  minTerminalPerTenant?: number;
  minTerminalGlobal?: number;
};

function rate(failed: number, terminal: number): number {
  return terminal > 0 ? failed / terminal : 0;
}

export function computeFailureRateReport(
  rows: RunRow[],
  opts: ThresholdOpts = {},
): FailureRateReport {
  const rateThreshold = opts.rateThreshold ?? DEFAULT_RATE_THRESHOLD;
  const minPerTenant = opts.minTerminalPerTenant ?? DEFAULT_MIN_TERMINAL_PER_TENANT;
  const minGlobal = opts.minTerminalGlobal ?? DEFAULT_MIN_TERMINAL_GLOBAL;

  const byTenant = new Map<string, { terminal: number; failed: number; parse_failed: number }>();
  let gTerminal = 0;
  let gFailed = 0;
  let gParseFailed = 0;

  for (const r of rows) {
    const status = (r.status ?? "").trim();
    if (!TERMINAL_STATUSES.has(status)) continue;
    const tid = (r.tenant_id ?? "").trim();
    const isFail = FAILURE_STATUSES.has(status);
    const isParseFail = status === "parse_failed";

    gTerminal += 1;
    if (isFail) gFailed += 1;
    if (isParseFail) gParseFailed += 1;

    if (tid) {
      const cur = byTenant.get(tid) ?? { terminal: 0, failed: 0, parse_failed: 0 };
      cur.terminal += 1;
      if (isFail) cur.failed += 1;
      if (isParseFail) cur.parse_failed += 1;
      byTenant.set(tid, cur);
    }
  }

  const perTenant: TenantFailureStat[] = Array.from(byTenant.entries())
    .map(([tenant_id, s]) => ({
      tenant_id,
      terminal: s.terminal,
      failed: s.failed,
      parse_failed: s.parse_failed,
      rate: rate(s.failed, s.terminal),
    }))
    .sort((a, b) => b.rate - a.rate || b.failed - a.failed);

  const alarmedTenants = perTenant.filter(
    (t) => t.terminal >= minPerTenant && t.rate >= rateThreshold,
  );

  const globalRate = rate(gFailed, gTerminal);
  const globalAlarmed = gTerminal >= minGlobal && globalRate >= rateThreshold;

  return {
    global: {
      terminal: gTerminal,
      failed: gFailed,
      rate: globalRate,
      parse_failed: gParseFailed,
    },
    perTenant,
    alarmedTenants,
    globalAlarmed,
  };
}
