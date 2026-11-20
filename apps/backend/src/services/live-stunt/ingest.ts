const HOUR_MS = 3_600_000;
const MAX_WINDOW_MS = 40 * 24 * HOUR_MS;
const MAX_ROWS = 1_000;
const MAX_METRICS = 20;
const MAX_COUNT = 1_000_000;
export const METRIC_RE = /^[a-z][a-z0-9_]{0,39}$/;

export type IngestRow = { hour: string; metrics: Record<string, number> };
export type IngestBody = { from: string; to: string; metrics: string[]; rows: IngestRow[] };

const hourAligned = (ms: number) => Number.isFinite(ms) && ms % HOUR_MS === 0;
const count = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT;

export function parseIngestBody(raw: unknown): IngestBody | string {
  if (!raw || typeof raw !== "object") return "body must be an object";
  const b = raw as Record<string, unknown>;
  const from = typeof b.from === "string" ? Date.parse(b.from) : NaN;
  const to = typeof b.to === "string" ? Date.parse(b.to) : NaN;
  if (!hourAligned(from) || !hourAligned(to)) return "from/to must be ISO times on the hour";
  if (!(from < to) || to - from > MAX_WINDOW_MS) return "window must be positive and at most 40 days";
  if (!Array.isArray(b.metrics) || b.metrics.length === 0 || b.metrics.length > MAX_METRICS) return `metrics must list 1 to ${MAX_METRICS} reported metric names`;
  const reported = new Set<string>();
  for (const n of b.metrics as unknown[]) {
    if (typeof n !== "string" || !METRIC_RE.test(n)) return "metrics must be lowercase snake_case names";
    reported.add(n);
  }
  if (!Array.isArray(b.rows) || b.rows.length > MAX_ROWS) return `rows must be an array of at most ${MAX_ROWS}`;
  const rows: IngestRow[] = [];
  const seen = new Set<number>();
  for (const r of b.rows as unknown[]) {
    const x = (r ?? {}) as Record<string, unknown>;
    const h = typeof x.hour === "string" ? Date.parse(x.hour) : NaN;
    if (!hourAligned(h) || h < from || h >= to) return "every row hour must be on the hour and inside [from, to)";
    if (seen.has(h)) return "duplicate hour";
    const m = x.metrics;
    if (!m || typeof m !== "object" || Array.isArray(m)) return "metrics must be an object of name: count";
    const entries = Object.entries(m as Record<string, unknown>);
    if (entries.length > MAX_METRICS) return `at most ${MAX_METRICS} metrics per hour`;
    const metrics: Record<string, number> = {};
    for (const [k, v] of entries) {
      if (!METRIC_RE.test(k)) return `metric name "${k.slice(0, 40)}" must be lowercase snake_case`;
      if (!reported.has(k)) return `metric "${k}" is not in the reported metrics list`;
      if (!count(v)) return `metric "${k}" must be a non-negative integer`;
      metrics[k] = v as number;
    }
    seen.add(h);
    rows.push({ hour: new Date(h).toISOString(), metrics });
  }
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), metrics: [...reported], rows };
}
