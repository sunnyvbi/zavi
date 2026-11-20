
export type MetricKey =
  | "spend_usd"
  | "ctr_percent"
  | "cpc_usd"
  | "cpm_usd"
  | "impressions"
  | "clicks"
  | "bookings"
  | "mer"
  | "cost_per_booking_usd"
  | "revenue_usd";

export type MetricKind = "volume" | "ratio";

export type MetricDef = {
  key: MetricKey;
  label: string;
  color: string;
  kind: MetricKind;
  fmt: (n: number) => string;
  defaultOn: boolean;
  money: boolean;
  inputs?: (row: Row) => string | null;
};

export function usd0(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
export function usd2(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function int0(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export const METRICS: MetricDef[] = [
  {
    key: "spend_usd",
    label: "Spend",
    color: "#1f4e9c",
    kind: "volume",
    fmt: usd0,
    defaultOn: true,
    money: false,
  },
  {
    key: "ctr_percent",
    label: "CTR",
    color: "#e8a317",
    kind: "ratio",
    fmt: (n) => `${n.toFixed(2)}%`,
    defaultOn: true,
    money: false,
    inputs: (r) =>
      r.clicks != null && r.impressions != null
        ? `${int0(r.clicks)} clicks ÷ ${int0(r.impressions)} impressions`
        : null,
  },
  {
    key: "cpc_usd",
    label: "CPC",
    color: "#4b5563",
    kind: "ratio",
    fmt: usd2,
    defaultOn: false,
    money: false,
    inputs: (r) =>
      r.spend_usd != null && r.clicks != null
        ? `${usd0(r.spend_usd)} spend ÷ ${int0(r.clicks)} clicks`
        : null,
  },
  {
    key: "cpm_usd",
    label: "CPM",
    color: "#35b5e8",
    kind: "ratio",
    fmt: usd2,
    defaultOn: false,
    money: false,
    inputs: (r) =>
      r.spend_usd != null && r.impressions != null
        ? `${usd0(r.spend_usd)} spend ÷ ${int0(r.impressions)} impressions`
        : null,
  },
  {
    key: "impressions",
    label: "Impressions",
    color: "#8e44d0",
    kind: "volume",
    fmt: int0,
    defaultOn: false,
    money: false,
  },
  {
    key: "clicks",
    label: "Clicks",
    color: "#e5619b",
    kind: "volume",
    fmt: int0,
    defaultOn: false,
    money: false,
  },
  {
    key: "bookings",
    label: "Bookings",
    color: "#00857a",
    kind: "volume",
    fmt: int0,
    defaultOn: true,
    money: true,
  },
  {
    key: "mer",
    label: "MER",
    color: "#3f9c2f",
    kind: "ratio",
    fmt: (n) => `${n.toFixed(2)}×`,
    defaultOn: true,
    money: true,
    inputs: (r) =>
      r.revenue_usd != null && r.spend_usd != null
        ? `${usd0(r.revenue_usd)} revenue ÷ ${usd0(r.spend_usd)} spend`
        : null,
  },
  {
    key: "cost_per_booking_usd",
    label: "Cost / booking",
    color: "#8a5a2b",
    kind: "ratio",
    fmt: usd0,
    defaultOn: true,
    money: true,
    inputs: (r) =>
      r.spend_usd != null && r.bookings != null
        ? `${usd0(r.spend_usd)} spend ÷ ${int0(r.bookings)} bookings`
        : null,
  },
  {
    key: "revenue_usd",
    label: "Revenue",
    color: "#c62828",
    kind: "volume",
    fmt: usd0,
    defaultOn: false,
    money: true,
  },
];

export type Row = { date: string; maturing: boolean } & Record<MetricKey, number | null>;

export type DeliveryPoint = {
  date: string;
  spend_usd: number;
  impressions: number;
  clicks: number;
  ctr_percent: number | null;
  cpc_usd: number | null;
  cpm_usd: number | null;
  maturing: boolean;
};

export type MoneyPoint = {
  date: string;
  bookings: number | null;
  revenue_usd: number | null;
  mer: number | null;
  cost_per_booking_usd: number | null;
};

export function buildRows(
  delivery: DeliveryPoint[],
  money: MoneyPoint[],
  moneyOn: boolean,
): Row[] {
  const byDate = new Map(money.map((p) => [p.date, p]));
  return delivery.map((p) => {
    const m = moneyOn ? byDate.get(p.date) : undefined;
    return {
      date: p.date,
      maturing: p.maturing,
      spend_usd: p.spend_usd,
      ctr_percent: p.ctr_percent,
      cpc_usd: p.cpc_usd,
      cpm_usd: p.cpm_usd,
      impressions: p.impressions,
      clicks: p.clicks,
      bookings: m ? m.bookings : null,
      mer: m ? m.mer : null,
      cost_per_booking_usd: m ? m.cost_per_booking_usd : null,
      revenue_usd: m ? m.revenue_usd : null,
    };
  });
}

export type Baseline = { value: number; date: string };

export function baselineFor(rows: Row[], key: MetricKey): Baseline | null {
  const settled = rows.filter((r) => !r.maturing);
  for (const pool of [settled, rows]) {
    for (const r of pool) {
      const v = r[key];
      if (typeof v === "number" && v !== 0) return { value: v, date: r.date };
    }
  }
  return null;
}

export function anchorsAgree(rows: Row[], keys: MetricKey[]): boolean {
  const dates = new Set<string>();
  for (const k of keys) {
    const b = baselineFor(rows, k);
    if (b) dates.add(b.date);
  }
  return dates.size <= 1;
}

export type ChartRow = { date: string; maturing: boolean } & Record<string, unknown>;

export function toChartRows(rows: Row[], keys: MetricKey[]): ChartRow[] {
  const baselines = new Map<MetricKey, Baseline | null>();
  for (const k of keys) baselines.set(k, baselineFor(rows, k));
  return rows.map((r) => {
    const out: ChartRow = { date: r.date, maturing: r.maturing };
    for (const k of keys) {
      const raw = r[k];
      out[`raw_${k}`] = raw ?? null;
      const base = baselines.get(k) ?? null;
      out[`idx_${k}`] =
        typeof raw === "number" && base && base.value !== 0
          ? Math.round((raw / base.value) * 1000) / 10
          : null;
    }
    return out;
  });
}

export function latestValue(rows: Row[], key: MetricKey): { value: number; date: string } | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = rows[i][key];
    if (typeof v === "number") return { value: v, date: rows[i].date };
  }
  return null;
}

export function missingDaysFor(rows: Row[], key: MetricKey): number {
  return rows.reduce((n, r) => (r[key] == null ? n + 1 : n), 0);
}

export function tileDomain(values: number[], kind: MetricKind): [number, number] {
  if (values.length === 0) return [0, 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return min === 0 ? [0, 1] : [Math.min(0, min), max * 1.2];
  const pad = (max - min) * 0.08;
  const lo = kind === "volume" ? Math.min(0, min) : min - pad;
  return [lo, max + pad];
}

export function stalenessDays(refreshedAt: string | null, lastDate: string | null): number {
  if (!refreshedAt || !lastDate) return 0;
  const refreshedDay = refreshedAt.slice(0, 10);
  if (refreshedDay >= lastDate) return 0;
  const a = Date.parse(`${refreshedDay}T00:00:00Z`);
  const b = Date.parse(`${lastDate}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export const MIN_COVERAGE_GAP_DAYS = 2;

export function coverageShortfallDays(
  lastPlotted: string | null,
  requestedEnd: string | null,
): number {
  if (!lastPlotted || !requestedEnd || lastPlotted >= requestedEnd) return 0;
  const a = Date.parse(`${lastPlotted}T00:00:00Z`);
  const b = Date.parse(`${requestedEnd}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export function fmtAxisDate(d: string): string {
  const [, m, day] = d.split("-");
  return m && day ? `${Number(m)}/${Number(day)}` : d;
}

export const MIN_SELECTED_METRICS = 2;
export const MAX_SELECTED_METRICS = 5;

export function clampSelection(
  wanted: MetricKey[],
  available: MetricDef[],
  min = MIN_SELECTED_METRICS,
  max = MAX_SELECTED_METRICS,
): MetricKey[] {
  const availableKeys = new Set(available.map((m) => m.key));
  const out: MetricKey[] = [];
  for (const k of wanted) {
    if (availableKeys.has(k) && !out.includes(k) && out.length < max) out.push(k);
  }
  const pool = [...available.filter((m) => m.defaultOn), ...available];
  for (const m of pool) {
    if (out.length >= min) break;
    if (!out.includes(m.key)) out.push(m.key);
  }
  return out;
}

export function defaultSelectionFor(
  channel: "meta" | "google" | undefined,
  available: MetricDef[],
): MetricKey[] {
  const has = (k: MetricKey) => available.some((m) => m.key === k);
  const cost: MetricKey =
    channel !== "google" && has("cost_per_booking_usd") ? "cost_per_booking_usd" : "cpc_usd";
  return clampSelection(["spend_usd", cost], available);
}
