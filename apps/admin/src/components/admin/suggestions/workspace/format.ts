export function fmtCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return value.toLocaleString("en-US");
}

export function fmtUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2).replace(/\.00$/, "")}M`;
  if (abs >= 10_000) return `$${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

export function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function fmtRoas(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}×`;
}

export function fmtMetric(value: number | null, unit: "count" | "usd" | "ratio"): string {
  if (unit === "usd") return fmtUsd(value);
  if (unit === "ratio") return fmtPct(value);
  return fmtCount(value);
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return fmtDate(iso);
}

const MULTI_PART_TLDS = new Set([
  "co.uk",
  "co.in",
  "co.jp",
  "co.nz",
  "co.za",
  "com.au",
  "com.br",
  "com.mx",
  "com.sg",
  "org.uk",
  "net.au",
  "ac.uk",
  "gov.uk",
]);

export function siteHref(domain: string): string {
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
}

export function displayDomain(domain: string): string {
  const host = domain
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split(/[/?#]/)[0]
    .split("@")
    .pop()!
    .split(":")[0]
    .replace(/\.$/, "")
    .toLowerCase();

  const labels = host.split(".").filter(Boolean);
  if (labels.length < 3) return host;

  const lastTwo = labels.slice(-2).join(".");
  const keep = MULTI_PART_TLDS.has(lastTwo) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

export function fmtDelta(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "↗" : "↘"} ${Math.abs(value * 100).toFixed(0)}%`;
}
