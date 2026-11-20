import type { MetricValue } from "./types";

const money = (currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 });
const NUM = new Intl.NumberFormat("en-US");

export function formatMetricValue(metric: MetricValue): string | null {
  if (metric.value === null) return null;
  return metric.unit === "usd" ? money(metric.currency || "USD").format(metric.value) : NUM.format(metric.value);
}

export function formatComparison(metric: MetricValue): { text: string; up: boolean } | null {
  if (metric.comparison === null) return null;
  const up = metric.comparison >= 0;
  const magnitude = Math.abs(metric.comparison);
  return { text: metric.unit === "usd" ? `${magnitude}%` : NUM.format(magnitude), up };
}

export function formatCredits(n: number): string {
  return NUM.format(n);
}

export function formatRelativeSync(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "not synced yet";
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "synced just now";
  if (minutes < 60) return `synced ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `synced ${hours} h ago`;
  return `synced ${Math.round(hours / 24)} d ago`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
