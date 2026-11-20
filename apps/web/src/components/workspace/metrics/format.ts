
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import { currencyFromUnit, formatCurrency } from "./currency";

const PCT_UNITS = new Set(["pct", "percent", "%"]);
const USD_UNITS = new Set(["usd", "$", "dollars"]);
const RATIO_UNITS = new Set(["ratio", "x", "×"]);

const LOWER_IS_BETTER = /(^|_)(cpa|cpc|cpm|cost|cost_per|bounce)/i;

export function lowerIsBetter(key: string): boolean {
  return LOWER_IS_BETTER.test(key);
}

function unitOf(m: Pick<ChannelMetric, "unit">): "pct" | "usd" | "currency" | "ratio" | "count" {
  if (currencyFromUnit(m.unit)) return "currency";
  const u = (m.unit ?? "").toLowerCase();
  if (PCT_UNITS.has(u)) return "pct";
  if (USD_UNITS.has(u)) return "usd";
  if (RATIO_UNITS.has(u)) return "ratio";
  return "count";
}

function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (abs >= 10_000) return `${(n / 1_000).toFixed(abs >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return n.toLocaleString("en-US", { maximumFractionDigits: Number.isInteger(n) ? 0 : 2 });
}

export function formatMetricValue(m: Pick<ChannelMetric, "value" | "unit">): string {
  if (m.value === null || m.value === undefined || !Number.isFinite(m.value)) return "-";
  switch (unitOf(m)) {
    case "pct":
      return `${m.value.toLocaleString("en-US", { maximumFractionDigits: Math.abs(m.value) < 1 ? 2 : 1 })}%`;
    case "usd": {
      const cents = Math.abs(m.value) < 1000 && !Number.isInteger(m.value);
      return `$${m.value.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
    }
    case "ratio":
      return `${m.value.toFixed(2)}×`;
    case "currency":
      return formatCurrency(m.value, currencyFromUnit(m.unit), Math.abs(m.value) < 1000 && !Number.isInteger(m.value));
    default:
      return compact(m.value);
  }
}

export type MetricDelta = {
  text: string;
  direction: "up" | "down";
  good: boolean;
};

export function metricDelta(m: ChannelMetric): MetricDelta | null {
  if (m.prev_value === null || m.prev_value === undefined || !Number.isFinite(m.prev_value)) return null;
  if (!Number.isFinite(m.value)) return null;
  const diff = m.value - m.prev_value;
  if (diff === 0) return null;
  const direction = diff > 0 ? "up" : "down";
  const good = lowerIsBetter(m.key) ? diff < 0 : diff > 0;
  const sign = diff > 0 ? "+" : "-";
  const unit = unitOf(m);
  let text: string;
  if (unit === "pct") {
    text = `${sign}${Math.abs(diff).toLocaleString("en-US", { maximumFractionDigits: 1 })}pp`;
  } else if (unit === "usd" && lowerIsBetter(m.key)) {
    text = `${sign}$${Math.abs(diff).toFixed(2)}`;
  } else if (unit === "currency" && lowerIsBetter(m.key)) {
    text = `${sign}${formatCurrency(Math.abs(diff), currencyFromUnit(m.unit), true)}`;
  } else if (m.prev_value === 0) {
    text = `${sign}${formatMetricValue({ value: Math.abs(diff), unit: m.unit })}`;
  } else {
    const pct = (Math.abs(diff) / Math.abs(m.prev_value)) * 100;
    text = `${sign}${pct.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  }
  return { text, direction, good };
}

export function humanizeMetricKey(key: string): string {
  return key
    .replace(/_(7d|14d|28d|30d)$/i, "")
    .replace(/_/g, " ")
    .replace(/\bcpa\b/i, "CPA")
    .replace(/\bctr\b/i, "CTR")
    .replace(/\broas\b/i, "ROAS")
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function roasVerdict(
  value: number | null | undefined,
  opts: { floor?: boolean; currency?: string } = {},
): Pick<ChannelMetric, "tone" | "note"> {
  if (value === null || value === undefined || !Number.isFinite(value)) return {};
  const back = opts.currency
    ? `${formatCurrency(value, opts.currency, true)} back per ${formatCurrency(1, opts.currency)} spent`
    : `$${value.toFixed(2)} back per $1 spent`;
  if (opts.floor) {
    return { tone: value < 1 ? "warn" : "good", note: `at least ${back}` };
  }
  return { tone: value < 1 ? "bad" : "good", note: back };
}

export const PACE_WARN_ABOVE = 105;
export const PACE_BAD_ABOVE = 125;

export function paceTone(pct: number | null | undefined): ChannelMetric["tone"] {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return undefined;
  if (pct > PACE_BAD_ABOVE) return "bad";
  if (pct > PACE_WARN_ABOVE) return "warn";
  return "good";
}
