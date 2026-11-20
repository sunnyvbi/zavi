
export type WatchSignal = {
  key: string;
  compare: "pct_change" | "abs_change";
  threshold: number;
};

export type WatchBlock = {
  signals: readonly WatchSignal[];
  trip: "any" | "all";
  max_interval_days?: number;
};

export type MetricSnapshotRow = {
  metric_key: string;
  value: number | null;
  status: "measured" | "unavailable";
  window_end: string;
};

export type SignalResult = {
  key: string;
  prev: number | null;
  now: number | null;
  prev_at?: string;
  now_at?: string;
  delta: number | null;
  tripped: boolean;
  reason?:
    | "no_baseline"
    | "no_current"
    | "unavailable"
    | "null_value"
    | "zero_baseline"
    | "same_window";
};

export type WatchVerdict = {
  verdict: "changed" | "unchanged" | "unavailable";
  signals: SignalResult[];
  reason?: string;
};

function baselineFor(rows: readonly MetricSnapshotRow[], at: Date | null): MetricSnapshotRow | null {
  if (!at) return null;
  const cutoff = at.getTime();
  let best: MetricSnapshotRow | null = null;
  for (const r of rows) {
    const t = Date.parse(r.window_end);
    if (!Number.isFinite(t) || t > cutoff) continue;
    if (!best || Date.parse(r.window_end) > Date.parse(best.window_end)) best = r;
  }
  return best;
}

function currentFor(rows: readonly MetricSnapshotRow[]): MetricSnapshotRow | null {
  let best: MetricSnapshotRow | null = null;
  for (const r of rows) {
    const t = Date.parse(r.window_end);
    if (!Number.isFinite(t)) continue;
    if (!best || t > Date.parse(best.window_end)) best = r;
  }
  return best;
}

function evaluateSignal(
  signal: WatchSignal,
  rows: readonly MetricSnapshotRow[],
  baselineAt: Date | null,
): SignalResult {
  const mine = rows.filter((r) => r.metric_key === signal.key);
  const base = baselineFor(mine, baselineAt);
  const cur = currentFor(mine);

  const empty = { key: signal.key, prev: null, now: null, delta: null, tripped: false };
  if (!cur) return { ...empty, reason: "no_current" };
  if (!base) return { ...empty, now: cur.value, reason: "no_baseline" };
  if (base.status === "unavailable" || cur.status === "unavailable") {
    return { ...empty, prev: base.value, now: cur.value, reason: "unavailable" };
  }
  if (base.value === null || cur.value === null) {
    return { ...empty, prev: base.value, now: cur.value, reason: "null_value" };
  }
  if (base.window_end === cur.window_end) {
    return {
      ...empty,
      prev: base.value,
      now: cur.value,
      prev_at: base.window_end,
      now_at: cur.window_end,
      reason: "same_window",
    };
  }

  if (signal.compare === "abs_change") {
    const delta = cur.value - base.value;
    return {
      key: signal.key, prev: base.value, now: cur.value, delta,
      prev_at: base.window_end, now_at: cur.window_end,
      tripped: Math.abs(delta) >= signal.threshold,
    };
  }

  if (base.value === 0) {
    return {
      key: signal.key, prev: 0, now: cur.value, delta: null,
      prev_at: base.window_end, now_at: cur.window_end,
      tripped: false, reason: "zero_baseline",
    };
  }
  const pct = ((cur.value - base.value) / Math.abs(base.value)) * 100;
  return {
    key: signal.key, prev: base.value, now: cur.value, delta: pct,
    prev_at: base.window_end, now_at: cur.window_end,
    tripped: Math.abs(pct) >= signal.threshold,
  };
}

export function evaluateWatch(
  block: WatchBlock,
  rows: readonly MetricSnapshotRow[],
  baselineAt: Date | null,
): WatchVerdict {
  if (block.signals.length === 0) {
    return { verdict: "unavailable", signals: [], reason: "no_signals_declared" };
  }

  const signals = block.signals.map((s) => evaluateSignal(s, rows, baselineAt));
  const evaluable = signals.filter((s) => !s.reason);
  if (evaluable.length === 0) {
    return {
      verdict: "unavailable",
      signals,
      reason: signals[0]?.reason ?? "not_evaluable",
    };
  }

  const tripped =
    block.trip === "all"
      ? evaluable.every((s) => s.tripped)
      : evaluable.some((s) => s.tripped);

  return { verdict: tripped ? "changed" : "unchanged", signals };
}

export type ProbeDeps = {
  channelStates: () => Promise<Array<{ channel_slug: string; last_run_at: string | null }>>;
  snapshots: (keys: readonly string[]) => Promise<MetricSnapshotRow[]>;
  write: (channel_slug: string, at: string, delta: WatchVerdict) => Promise<void>;
  watchFor: (channel_slug: string) => WatchBlock | null;
};

export async function runWatchProbes(
  deps: ProbeDeps,
  now: Date,
): Promise<{ probed: number; changed: number; unavailable: number }> {
  const states = await deps.channelStates();
  const watched = states
    .map((s) => ({ ...s, block: deps.watchFor(s.channel_slug) }))
    .filter((s): s is typeof s & { block: WatchBlock } => s.block !== null);

  if (watched.length === 0) return { probed: 0, changed: 0, unavailable: 0 };

  const keys = [...new Set(watched.flatMap((w) => w.block.signals.map((s) => s.key)))];
  const rows = keys.length > 0 ? await deps.snapshots(keys) : [];

  let changed = 0;
  let unavailable = 0;
  for (const w of watched) {
    const baselineAt = w.last_run_at ? new Date(w.last_run_at) : null;
    const verdict = evaluateWatch(w.block, rows, baselineAt);
    if (verdict.verdict === "changed") changed += 1;
    if (verdict.verdict === "unavailable") unavailable += 1;
    await deps.write(w.channel_slug, now.toISOString(), verdict);
  }
  return { probed: watched.length, changed, unavailable };
}
