
export type GoalMetricOption = {
  value: string;
  label: string;
  measurable: boolean;
  unit: "usd" | "count";
};

export const CUSTOM_METRIC = "__custom__";

export const GOAL_METRIC_OPTIONS: readonly GoalMetricOption[] = [
  { value: "mrr", label: "MRR (monthly recurring revenue)", measurable: true, unit: "usd" },
  { value: "arr", label: "ARR (annual recurring revenue)", measurable: true, unit: "usd" },
  { value: "signups", label: "Signups", measurable: true, unit: "count" },
  { value: "bookings", label: "Bookings", measurable: true, unit: "count" },
  { value: "rentals", label: "Rentals", measurable: true, unit: "count" },
  { value: "activations", label: "Activations", measurable: true, unit: "count" },
  { value: "purchases", label: "Purchases", measurable: true, unit: "count" },
  { value: "gmv", label: "GMV (gross merchandise value)", measurable: false, unit: "usd" },
  { value: "suppliers", label: "Suppliers / hosts", measurable: false, unit: "count" },
  { value: "active users", label: "Active users", measurable: false, unit: "count" },
  { value: "retention", label: "Retention rate", measurable: false, unit: "count" },
];

export function findMetricOption(value: string): GoalMetricOption | undefined {
  return GOAL_METRIC_OPTIONS.find((o) => o.value === value);
}

export function formatTargetValue(raw: string, unit: "usd" | "count"): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const grouped = n.toLocaleString("en-US");
  return unit === "usd" ? `$${grouped}` : grouped;
}

export function isoDateInDays(days: number, from: Date): string {
  const d = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export function humanDate(iso: string, from: Date): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getUTCFullYear() === from.getUTCFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

export function composeObjective(args: {
  metricValue: string;
  customMetric: string;
  targetValue: string;
  dueDateIso: string;
  now: Date;
}): string {
  const { metricValue, customMetric, targetValue, dueDateIso, now } = args;
  const opt = findMetricOption(metricValue);
  const label = opt
    ? opt.label.replace(/\s*\(.*\)$/, "")
    : customMetric.trim();
  if (!label || targetValue.trim() === "") return "";
  const unit = opt?.unit ?? "count";
  const target = formatTargetValue(targetValue, unit);
  const when = dueDateIso ? ` by ${humanDate(dueDateIso, now)}` : "";
  return `Grow ${label} to ${target}${when}`;
}
