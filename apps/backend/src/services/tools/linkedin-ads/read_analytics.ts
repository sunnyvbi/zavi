
import { z } from "zod";
import { listLinkedInAdAccounts, readLinkedInAdAnalytics, readLinkedInAdAnalyticsWithToken, type AdAnalyticsOpts, type AdAnalyticsRow } from "@/services/connectors/linkedin-ads/client";
import type { ToolSpec } from "@/services/tools/types";
import { linkedinAccountAccess } from "./_wallet";

const inputSchema = z.object({
  account_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[1-9]\d*$/, "account_id must be a numeric LinkedIn ad-account id")
    .describe("LinkedIn Ads account id, from linkedin_ads_list_accounts."),
  pivot: z
    .enum(["ACCOUNT", "CAMPAIGN"])
    .default("CAMPAIGN")
    .describe("ACCOUNT = one total row; CAMPAIGN = one row per campaign."),
  lookback_days: z.number().int().min(1).max(90).default(30),
});

function ymd(d: Date): { year: number; month: number; day: number } {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

type Row = AdAnalyticsRow & { currency: string | null };

const TRACKING_HISTORY_DAYS = 365;
const PAUSE_WINDOW_DAYS = 30;
const METRICS = ["impressions", "clicks", "spend", "conversions", "leads"] as const;
type Metric = (typeof METRICS)[number];
const NO_DATA_NOTE =
  "LinkedIn returned no analytics rows for this window. That can mean no delivery or numbers too small to report, so it is not a measured zero. Say no analytics came back; do not state zero spend or zero results.";
const UNREAD_TOTALS_NOTE =
  "LinkedIn left the metrics in unread_metrics out of at least one row, so those totals add only the rows that reported them. Say they are partial, not exact, and a null is unknown, not zero.";

export type PauseSignal = "has_results" | "metrics_unread" | "no_spend" | "tracking_unverified" | "tracking_history_unread" | "pause_candidate";

export const PAUSE_NOTE: Record<PauseSignal, string> = {
  has_results: "It has conversions or lead-form leads in this window. Not waste.",
  metrics_unread:
    "LinkedIn left some of this campaign's numbers out of this window (see missing_metrics), so a missing number is unknown, not zero. Do not state it as zero and do not propose a pause for waste.",
  no_spend: "No spend in this window. Nothing to pause for waste.",
  tracking_unverified:
    "No conversions or lead-form leads, and this campaign has never shown one in the last year, so its tracking is unverified and zero results are not proof of waste, even if other campaigns in the account have results. Say tracking is unverified for this campaign; do not propose a pause for waste.",
  tracking_history_unread:
    "No conversions or lead-form leads in this window, and this campaign's history for the last year could not be read just now, so whether its tracking works is unknown. Say the history could not be read; do not propose a pause for waste.",
  pause_candidate:
    "Spent with no conversions and no lead-form leads in this window, while this campaign has shown results in the last year, so its tracking works. A pause for waste may be proposed, citing these numbers.",
};

function counted(r: AdAnalyticsRow, metric: "conversions" | "leads"): boolean {
  return !(r.missing_metrics ?? []).includes(metric);
}

function hasCountedResults(r: AdAnalyticsRow): boolean {
  return (counted(r, "conversions") && r.conversions > 0) || (counted(r, "leads") && r.leads > 0);
}

function fullyMeasured(r: AdAnalyticsRow): boolean {
  return counted(r, "conversions") && counted(r, "leads");
}

function isMissing(r: AdAnalyticsRow, metric: Metric): boolean {
  return (r.missing_metrics ?? []).includes(metric);
}

export function pauseSignals(rows: AdAnalyticsRow[], history: AdAnalyticsRow[] = [], historyRead = true): { tracking: "verified" | "unverified"; signals: PauseSignal[] } {
  const tracked = new Set([...rows, ...history].filter(hasCountedResults).map((r) => r.pivot));
  const signals = rows.map((r): PauseSignal => {
    if (hasCountedResults(r)) return "has_results";
    if (isMissing(r, "spend") || !fullyMeasured(r)) return "metrics_unread";
    if (!(r.spend > 0)) return "no_spend";
    if (tracked.has(r.pivot)) return "pause_candidate";
    if (!historyRead || !history.some((h) => h.pivot === r.pivot && fullyMeasured(h))) return "tracking_history_unread";
    return "tracking_unverified";
  });
  return { tracking: signals.includes("metrics_unread") || signals.includes("tracking_unverified") || signals.includes("tracking_history_unread") || !signals.some((s) => s === "has_results" || s === "pause_candidate") ? "unverified" : "verified", signals };
}

export type ReadRows = (opts: AdAnalyticsOpts) => Promise<AdAnalyticsRow[]>;

export async function trackingHistory(read: ReadRows, raw: AdAnalyticsRow[], pivot: AdAnalyticsOpts["pivot"], end: Date, campaigns?: string[]): Promise<{ history: AdAnalyticsRow[]; historyRead: boolean }> {
  if (!raw.some((r) => r.spend > 0 && r.conversions + r.leads === 0)) return { history: [], historyRead: true };
  try {
    const history = await read({ pivot, ...(campaigns ? { campaigns } : {}), start: ymd(new Date(end.getTime() - TRACKING_HISTORY_DAYS * 86_400_000)), end: ymd(end) });
    return { history, historyRead: true };
  } catch {
    return { history: [], historyRead: false };
  }
}

export async function readCampaignPauseSignal(read: ReadRows, campaignId: string, end = new Date()): Promise<{ signal: PauseSignal; note: string }> {
  const urn = `urn:li:sponsoredCampaign:${campaignId}`;
  const own = (rows: AdAnalyticsRow[]) => rows.filter((r) => r.pivot === urn);
  const start = new Date(end.getTime() - (PAUSE_WINDOW_DAYS - 1) * 86_400_000);
  const rows = own(await read({ pivot: "CAMPAIGN", campaigns: [urn], start: ymd(start), end: ymd(end) }));
  if (!rows.length) return { signal: "metrics_unread", note: NO_DATA_NOTE };
  const { history, historyRead } = await trackingHistory(read, rows, "CAMPAIGN", end, [urn]);
  const signal = pauseSignals(rows, own(history), historyRead).signals[0];
  return { signal, note: PAUSE_NOTE[signal] };
}

export function spendTotals(rows: Row[]): { spend: number | null; currency: string | null; spend_by_currency?: Record<string, number> } {
  const currencies = new Set(rows.map((r) => r.currency ?? "UNKNOWN"));
  if (currencies.size <= 1) {
    const only = rows[0]?.currency ?? null;
    return { spend: rows.reduce((t, r) => t + r.spend, 0), currency: only };
  }
  const by: Record<string, number> = {};
  for (const r of rows) by[r.currency ?? "UNKNOWN"] = (by[r.currency ?? "UNKNOWN"] ?? 0) + r.spend;
  return { spend: null, currency: null, spend_by_currency: by };
}

async function accountCurrency(tenant_id: string, account_id: string): Promise<string | null> {
  const accounts = await listLinkedInAdAccounts(tenant_id).catch(() => null);
  const c = accounts?.find((a) => a.id === account_id)?.currency;
  return typeof c === "string" && /^[A-Z]{3}$/.test(c) ? c : null;
}

export const linkedinAdsReadAnalyticsTool: ToolSpec = {
  name: "linkedin_ads_read_analytics",
  effect: "read",
  description:
    "Read spend, impressions, clicks, conversions and lead-form leads for one LinkedIn Ads account over the last " +
    "N days, as one whole-window row per account or per campaign. Read-only — never edits or spends. " +
    "Every spend carries the account's currency; never restate it in another currency or symbol. " +
    "Each row has pause_signal and pause_note: the pause tool refuses anything but pause_candidate. " +
    "Numbers are LinkedIn's privacy-noised totals; small values (<3) may be suppressed. Get account_id " +
    "from linkedin_ads_list_accounts first.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { account_id, pivot: asked, lookback_days } = inputSchema.parse(input);
    const end = new Date();
    const start = new Date(end.getTime() - (lookback_days - 1) * 86_400_000);
    const access = await linkedinAccountAccess(ctx.tenant_id, account_id);
    const pivot = access.kind === "wallet" ? "CAMPAIGN" : asked;
    const read: ReadRows =
      access.kind === "wallet"
        ? async (o) => {
            const urns = (o.campaigns ?? access.campaignUrns).filter((u) => access.campaignUrns.includes(u));
            if (!urns.length) return [];
            const rows = await readLinkedInAdAnalyticsWithToken(access.token, account_id, { ...o, pivot: "CAMPAIGN", campaigns: urns });
            return rows.filter((r) => r.pivot !== null && urns.includes(r.pivot));
          }
        : (o) => readLinkedInAdAnalytics(ctx.tenant_id, account_id, o);
    const [raw, currency] = await Promise.all([
      read({ pivot, start: ymd(start), end: ymd(end) }),
      access.kind === "wallet" ? Promise.resolve(/^[A-Z]{3}$/.test(access.currency) ? access.currency : null) : accountCurrency(ctx.tenant_id, account_id),
    ]);
    const { history, historyRead } = await trackingHistory(read, raw, pivot, end);
    const { tracking, signals } = pauseSignals(raw, history, historyRead);
    const rows = raw.map((r, i) => ({
      ...r,
      ...Object.fromEntries(METRICS.filter((metric) => isMissing(r, metric)).map((metric) => [metric, null])),
      currency,
      pause_signal: signals[i],
      pause_note: PAUSE_NOTE[signals[i]],
    }));
    const reported = (metric: Metric) => raw.filter((r) => !isMissing(r, metric));
    const total = (metric: Metric) => (reported(metric).length ? reported(metric).reduce((t, r) => t + r[metric], 0) : null);
    const unread = METRICS.filter((metric) => raw.some((r) => isMissing(r, metric)));
    const money = reported("spend").length ? spendTotals(reported("spend").map((r) => ({ ...r, currency }))) : { spend: null, currency };
    const totals = {
      impressions: total("impressions"),
      clicks: total("clicks"),
      ...money,
      conversions: total("conversions"),
      leads: total("leads"),
    };
    return {
      account_id,
      currency,
      ...(currency ? {} : { currency_note: "The account currency could not be read. State spend as a bare number in the account's currency, never with a $ or any other symbol." }),
      pivot,
      ...(pivot !== asked ? { pivot_note: "This is the Zavi ads wallet account, shared with other advertisers, so only this workspace's campaigns are read, one row per campaign." } : {}),
      lookback_days,
      count: rows.length,
      conversion_tracking: tracking,
      totals,
      ...(raw.length ? {} : { no_data_note: NO_DATA_NOTE }),
      ...(unread.length ? { unread_metrics: unread, unread_totals_note: UNREAD_TOTALS_NOTE } : {}),
      rows,
    };
  },
};
