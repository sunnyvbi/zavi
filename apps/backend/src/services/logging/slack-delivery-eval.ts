
export const OUTBOX_FAILURE_STATUSES = new Set(["failed"]);
export const OUTBOX_TERMINAL_STATUSES = new Set(["failed", "sent"]);
export const OUTBOX_INFLIGHT_STATUSES = new Set(["pending", "sending"]);

export const DELIVERY_FAILURE_LOG_CODES = [
  "post_failed",
] as const;

export const DEFAULT_RATE_THRESHOLD = 0.5;
export const DEFAULT_MIN_FAILURES_PER_TENANT = 3;
export const DEFAULT_SPIKE_COUNT_PER_TENANT = 5;
export const DEFAULT_MIN_FAILURES_GLOBAL = 5;
export const DEFAULT_MIN_TERMINAL_GLOBAL = 10;
export const DEFAULT_SPIKE_COUNT_GLOBAL = 10;
export const DEFAULT_STALE_PENDING_MS = 10 * 60 * 1000;
export const DEFAULT_STALE_PENDING_MIN = 5;

export type OutboxRow = { tenant_id: string | null; status: string | null };
export type StaleRow = { tenant_id: string | null };
export type FailureLogRow = { tenant_id: string | null };

export type TenantDeliveryStat = {
  tenant_id: string;
  terminal: number;
  failed: number;
  stale: number;
  rate: number;
};

export type DeliveryFailureReport = {
  global: { terminal: number; failed: number; rate: number };
  perTenant: TenantDeliveryStat[];
  alarmedTenants: TenantDeliveryStat[];
  globalAlarmed: boolean;
  spikeAlarmed: boolean;
  stalePending: number;
  staleAlarmed: boolean;
  affectedTenants: number;
};

export type ThresholdOpts = {
  rateThreshold?: number;
  minFailuresPerTenant?: number;
  spikeCountPerTenant?: number;
  minFailuresGlobal?: number;
  minTerminalGlobal?: number;
  spikeCountGlobal?: number;
  stalePendingMs?: number;
  stalePendingMin?: number;
};

function rate(failed: number, terminal: number): number {
  return terminal > 0 ? failed / terminal : 0;
}

export function computeDeliveryFailureReport(
  args: {
    terminal: OutboxRow[];
    stale: StaleRow[];
    replyFailures: FailureLogRow[];
  },
  opts: ThresholdOpts = {},
): DeliveryFailureReport {
  const rateThreshold = opts.rateThreshold ?? DEFAULT_RATE_THRESHOLD;
  const minPerTenant = opts.minFailuresPerTenant ?? DEFAULT_MIN_FAILURES_PER_TENANT;
  const spikePerTenant = opts.spikeCountPerTenant ?? DEFAULT_SPIKE_COUNT_PER_TENANT;
  const minFailGlobal = opts.minFailuresGlobal ?? DEFAULT_MIN_FAILURES_GLOBAL;
  const minTermGlobal = opts.minTerminalGlobal ?? DEFAULT_MIN_TERMINAL_GLOBAL;
  const spikeBar = opts.spikeCountGlobal ?? DEFAULT_SPIKE_COUNT_GLOBAL;
  const staleMin = opts.stalePendingMin ?? DEFAULT_STALE_PENDING_MIN;

  const byTenant = new Map<string, { terminal: number; failed: number; stale: number }>();
  let gTerminal = 0;
  let gFailed = 0;

  const bump = (tid: string, d: { terminal?: number; failed?: number; stale?: number }) => {
    if (!tid) return;
    const cur = byTenant.get(tid) ?? { terminal: 0, failed: 0, stale: 0 };
    cur.terminal += d.terminal ?? 0;
    cur.failed += d.failed ?? 0;
    cur.stale += d.stale ?? 0;
    byTenant.set(tid, cur);
  };

  for (const r of args.terminal) {
    const status = (r.status ?? "").trim();
    if (!OUTBOX_TERMINAL_STATUSES.has(status)) continue;
    const isFail = OUTBOX_FAILURE_STATUSES.has(status);
    gTerminal += 1;
    if (isFail) gFailed += 1;
    bump((r.tenant_id ?? "").trim(), { terminal: 1, failed: isFail ? 1 : 0 });
  }

  for (const r of args.replyFailures) {
    gFailed += 1;
    bump((r.tenant_id ?? "").trim(), { failed: 1 });
  }

  const stalePending = args.stale.length;
  for (const r of args.stale) bump((r.tenant_id ?? "").trim(), { stale: 1 });

  const perTenant: TenantDeliveryStat[] = Array.from(byTenant.entries())
    .map(([tenant_id, s]) => ({
      tenant_id,
      terminal: s.terminal,
      failed: s.failed,
      stale: s.stale,
      rate: rate(s.failed, s.terminal),
    }))
    .sort((a, b) => b.failed - a.failed || b.stale - a.stale || b.rate - a.rate);

  const alarmedTenants = perTenant.filter(
    (t) =>
      (t.failed >= minPerTenant && t.rate >= rateThreshold) ||
      t.failed >= spikePerTenant,
  );

  const globalRate = rate(gFailed, gTerminal);
  const globalAlarmed =
    gFailed >= minFailGlobal && gTerminal >= minTermGlobal && globalRate >= rateThreshold;
  const spikeAlarmed = gFailed >= spikeBar;
  const staleAlarmed = stalePending >= staleMin;

  return {
    global: { terminal: gTerminal, failed: gFailed, rate: globalRate },
    perTenant,
    alarmedTenants,
    globalAlarmed,
    spikeAlarmed,
    stalePending,
    staleAlarmed,
    affectedTenants: perTenant.filter((t) => t.failed > 0 || t.stale > 0).length,
  };
}

export function bucketKey(nowMs: number, windowMs: number): string {
  return String(Math.floor(nowMs / windowMs));
}
