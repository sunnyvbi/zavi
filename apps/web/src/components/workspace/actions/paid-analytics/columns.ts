import { formatCurrency } from "../../metrics/currency";
import type { AnalyticsRow, VideoTotals } from "./model";

type Summed = "spend" | "conversions" | "value" | "clicks" | "impressions" | "engagements";
export type PaidColumn = {
  label: string;
  cell: (row: AnalyticsRow, currency: string | null) => string;
  foot: (rows: readonly AnalyticsRow[], currency: string | null, video: VideoTotals | null) => string;
};

const count = (n: number | null | undefined) => n == null ? "-" : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const rate = (n: number | null | undefined) => n == null ? "-" : `${n.toFixed(2)}%`;
const sum = (rows: readonly AnalyticsRow[], field: Summed) => rows.some((r) => r[field] == null) ? null : rows.reduce((total, row) => total + (row[field] ?? 0), 0);
const each = (spend: number | null, per: number | null) => spend != null && per != null && per > 0 ? spend / per : null;

const ratio = (top: number | null | undefined, bottom: number | null | undefined) => top != null && bottom ? (top / bottom) * 100 : null;

const spend = (cents: boolean): PaidColumn => ({ label: "Spend", cell: (r, c) => formatCurrency(r.spend, c, cents), foot: (rows, c) => formatCurrency(sum(rows, "spend"), c, cents) });
const conversions: PaidColumn = { label: "Conversions", cell: (r) => count(r.conversions), foot: (rows) => count(sum(rows, "conversions")) };

export const STANDARD_COLUMNS: readonly PaidColumn[] = [
  spend(false),
  conversions,
  { label: "Cost per conversion", cell: (r, c) => formatCurrency(r.cpa, c, true), foot: (rows, c) => formatCurrency(each(sum(rows, "spend"), sum(rows, "conversions")), c, true) },
  { label: "Conversion value", cell: (r, c) => formatCurrency(r.value, c), foot: (rows, c) => formatCurrency(sum(rows, "value"), c) },
];

export const VIDEO_COLUMNS: readonly PaidColumn[] = [
  { label: "Views", cell: (r) => count(r.views), foot: (_, __, video) => count(video?.views) },
  { label: "View rate", cell: (r) => rate(r.viewRate), foot: (_, __, video) => rate(video?.viewRate) },
  { label: "Average cost per view", cell: (r, c) => formatCurrency(r.cpv, c, true), foot: (_, c, video) => formatCurrency(video?.cpv, c, true) },
  { label: "Clicks", cell: (r) => count(r.clicks), foot: (rows, _, video) => count(video?.clicks ?? sum(rows, "clicks")) },
  conversions,
  spend(true),
];

export const TIKTOK_COLUMNS: readonly PaidColumn[] = [
  { label: "Video views", cell: (r) => count(r.views), foot: (_, __, video) => count(video?.views) },
  { label: "Clicks", cell: (r) => count(r.clicks), foot: (rows, _, video) => count(video?.clicks ?? sum(rows, "clicks")) },
  { label: "Click-through rate", cell: (r) => rate(ratio(r.clicks, r.impressions)), foot: (_, __, video) => rate(video?.ctr) },
  conversions,
  { label: "Cost per conversion", cell: (r, c) => formatCurrency(r.cpa, c, true), foot: (_, c, video) => formatCurrency(video?.cpa, c, true) },
  spend(true),
];

export const X_COLUMNS: readonly PaidColumn[] = [
  { label: "Impressions", cell: (r) => count(r.impressions), foot: (rows) => count(sum(rows, "impressions")) },
  { label: "Engagements", cell: (r) => count(r.engagements), foot: (rows) => count(sum(rows, "engagements")) },
  { label: "Link clicks", cell: (r) => count(r.clicks), foot: (rows) => count(sum(rows, "clicks")) },
  conversions,
  spend(true),
];

export const REDDIT_COLUMNS: readonly PaidColumn[] = [
  { label: "Impressions", cell: (r) => count(r.impressions), foot: (rows) => count(sum(rows, "impressions")) },
  { label: "Clicks", cell: (r) => count(r.clicks), foot: (rows) => count(sum(rows, "clicks")) },
  { label: "Click-through rate", cell: (r) => rate(ratio(r.clicks, r.impressions)), foot: (rows) => rate(ratio(sum(rows, "clicks"), sum(rows, "impressions"))) },
  { label: "Cost per click", cell: (r, c) => formatCurrency(each(r.spend, r.clicks ?? null), c, true), foot: (rows, c) => formatCurrency(each(sum(rows, "spend"), sum(rows, "clicks")), c, true) },
  conversions,
  spend(true),
];
