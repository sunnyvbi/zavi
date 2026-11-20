import { agoText, formatWindow, sourceName } from "./receiptFormat";

type ItemReceipt = {
  source: string;
  metric_id?: string;
  fetched_at?: string;
  window?: { since: string; until: string };
};

export type KpiItemLike = {
  label: string;
  tone?: "up" | "down" | "flat";
  verified?: boolean;
  receipt?: ItemReceipt;
};

export function isNeutralMetric(idOrLabel: string | undefined | null): boolean {
  if (!idOrLabel) return false;
  return /(^|[_\s-])(ad_)?spend($|[_\s-])|ad spend|ads spend|spend_total|ad_spend/i.test(idOrLabel);
}

export function deltaTone(item: KpiItemLike): "up" | "down" | "neutral" {
  if (isNeutralMetric(item.receipt?.metric_id) || isNeutralMetric(item.label)) return "neutral";
  return item.tone === "up" || item.tone === "down" ? item.tone : "neutral";
}

export type KpiChip = { kind: "verified"; label: string } | { kind: "unverified"; label: string };

export function kpiChip(item: KpiItemLike, now: number = Date.now()): KpiChip | null {
  if (item.verified === true && item.receipt) {
    const r = item.receipt;
    const parts = [sourceName(r.source) ?? "Zavi", formatWindow(r.window), agoText(r.fetched_at, now)];
    return { kind: "verified", label: parts.filter(Boolean).join(" · ") };
  }
  if (item.verified === false) return { kind: "unverified", label: "Unverified" };
  return null;
}
