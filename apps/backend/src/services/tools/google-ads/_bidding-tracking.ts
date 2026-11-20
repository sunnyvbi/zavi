import type { GoogleAdsSearch } from "./_client";
import type { CampaignRef } from "./_conversion-goals";

const OFFLINE_UPLOAD_TYPES: ReadonlySet<string> = new Set(["UPLOAD_CLICKS", "UPLOAD_CALLS", "STORE_SALES_DIRECT_UPLOAD", "STORE_SALES"]);

export const BIDDING_WINDOW_DAYS = 14;
export const RECENT_UPLOAD_DAYS = 7;
export const MIN_CLICKS_FOR_DARK = 100;
export const MIN_UPLOAD_SUCCESS_SHARE = 0.5;
export const MIN_PROCESSED_UPLOAD_EVENTS = 10;

export type ActionVerdict = "recording" | "dark" | "uploads_failing" | "warming_up" | "low_traffic" | "unknown";
export type BiddingVerdict = "ok" | "broken" | "warming_up" | "no_bidding_action" | "unknown";

export type UploadSummary = {
  statuses: string[];
  successful_events: number | null;
  failed_events: number | null;
  pending_events: number | null;
  last_upload_at: string | null;
  recent_successful_days: number | null;
  alerts: string[];
};

export type BiddingAction = {
  resource_name: string;
  name: string | null;
  campaigns: CampaignRef[];
  conversions_14d: number | null;
  campaign_clicks_14d: number | null;
  upload: UploadSummary | null;
  upload_read_failed?: boolean;
  upload_owned_elsewhere?: boolean;
  verdict: ActionVerdict;
  why: string;
};

export type BiddingTracking = {
  verdict: BiddingVerdict;
  note: string | null;
  since: string | null;
  since_is_lower_bound: boolean;
  actions: BiddingAction[];
  window_days: number;
  upload_summary_read: "ok" | "failed";
};

type UploadRow = {
  offlineConversionUploadConversionActionSummary?: {
    conversionActionId?: string | number;
    status?: string;
    successfulEventCount?: string | number;
    totalEventCount?: string | number;
    pendingEventCount?: string | number;
    lastUploadDateTime?: string;
    dailySummaries?: Array<{ uploadDate?: string; successfulCount?: string | number; failedCount?: string | number; pendingCount?: string | number }>;
    alerts?: Array<{ error?: Record<string, unknown>; errorPercentage?: number }>;
  };
};

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const DAY_MS = 86_400_000;
const ageDays = (s: string | null | undefined, now: Date) => {
  if (!s) return null;
  const t = Date.parse(`${s.replace(" ", "T").slice(0, 19)}Z`);
  return Number.isFinite(t) ? (now.getTime() - t) / DAY_MS : null;
};

export function mergeUploadRows(rows: readonly UploadRow[], now: Date): Map<string, UploadSummary> {
  const out = new Map<string, UploadSummary>();
  const days = new Map<string, Set<string>>();
  const add = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
  for (const row of rows) {
    const u = row.offlineConversionUploadConversionActionSummary ?? {};
    if (u.conversionActionId == null) continue;
    const id = String(u.conversionActionId);
    const cur = out.get(id) ?? { statuses: [], successful_events: null, failed_events: null, pending_events: null, last_upload_at: null, recent_successful_days: null, alerts: [] };
    const daily = Array.isArray(u.dailySummaries) ? u.dailySummaries : null;
    let ok: number | null, failed: number | null, pending: number | null;
    let stale = false;
    if (daily) {
      ok = daily.reduce((n, d) => n + (num(d.successfulCount) ?? 0), 0);
      failed = daily.reduce((n, d) => n + (num(d.failedCount) ?? 0), 0);
      pending = daily.reduce((n, d) => n + (num(d.pendingCount) ?? 0), 0);
      const set = days.get(id) ?? new Set<string>();
      for (const d of daily) if ((num(d.successfulCount) ?? 0) > 0 && d.uploadDate) set.add(d.uploadDate);
      days.set(id, set);
    } else if ((ageDays(u.lastUploadDateTime, now) ?? Infinity) > RECENT_UPLOAD_DAYS + 1) {
      ok = null;
      failed = null;
      pending = null;
      stale = true;
    } else {
      ok = num(u.successfulEventCount);
      pending = num(u.pendingEventCount);
      const total = num(u.totalEventCount);
      failed = total === null || ok === null ? null : Math.max(0, total - ok - (pending ?? 0));
    }
    const last = [cur.last_upload_at, u.lastUploadDateTime ?? null].filter((x): x is string => !!x).sort().at(-1) ?? null;
    out.set(id, {
      statuses: u.status && !stale ? [...cur.statuses, u.status] : cur.statuses,
      successful_events: add(cur.successful_events, ok),
      failed_events: add(cur.failed_events, failed),
      pending_events: add(cur.pending_events, pending),
      last_upload_at: last,
      recent_successful_days: days.has(id) ? days.get(id)!.size : cur.recent_successful_days,
      alerts: [
        ...cur.alerts,
        ...(stale ? [] : u.alerts ?? []).map((a) => Object.values(a.error ?? {}).filter((v) => typeof v === "string").join(" ")).filter(Boolean),
      ],
    });
  }
  return out;
}

function uploadedRecently(u: UploadSummary | null, now: Date): boolean {
  if (!u) return false;
  if ((u.recent_successful_days ?? 0) > 0) return true;
  const age = ageDays(u.last_upload_at, now);
  return age !== null && age <= RECENT_UPLOAD_DAYS + 1 && ((u.successful_events ?? 0) > 0 || (u.pending_events ?? 0) > 0);
}

function uploadsFailing(u: UploadSummary | null, now: Date): boolean {
  if (!u) return false;
  const age = ageDays(u.last_upload_at, now);
  if (u.recent_successful_days === null && (age === null || age > RECENT_UPLOAD_DAYS + 1)) return false;
  if (u.successful_events === null || u.failed_events === null) return u.statuses.includes("NEEDS_ATTENTION");
  const processed = u.successful_events + u.failed_events;
  return processed >= MIN_PROCESSED_UPLOAD_EVENTS && u.successful_events / processed < MIN_UPLOAD_SUCCESS_SHARE;
}

export function judgeAction(a: Omit<BiddingAction, "verdict" | "why">, now: Date): { verdict: ActionVerdict; why: string } {
  if (uploadsFailing(a.upload, now)) {
    const u = a.upload!;
    const share = u.failed_events !== null && u.successful_events !== null
      ? `${u.successful_events} of ${u.successful_events + u.failed_events} processed upload events accepted in ${RECENT_UPLOAD_DAYS} days`
      : "Google rates the uploads NEEDS_ATTENTION";
    return { verdict: "uploads_failing", why: `${share}${u.alerts.length ? ` (${u.alerts[0]})` : ""}` };
  }
  if (a.conversions_14d === null) return { verdict: "unknown", why: "its conversions could not be read" };
  if (a.conversions_14d > 0) return { verdict: "recording", why: `${a.conversions_14d} conversions in ${BIDDING_WINDOW_DAYS} days` };
  if (uploadedRecently(a.upload, now)) {
    return { verdict: "warming_up", why: `0 conversions in ${BIDDING_WINDOW_DAYS} days, but uploads were accepted in the last ${RECENT_UPLOAD_DAYS} days; Google can take several days to show them` };
  }
  if (a.campaign_clicks_14d === null) return { verdict: "unknown", why: "the clicks of its campaigns could not be read" };
  if (a.upload_read_failed) return { verdict: "unknown", why: "0 conversions, but Google's upload summary could not be read to rule out recent uploads" };
  if (a.campaign_clicks_14d < MIN_CLICKS_FOR_DARK) {
    return { verdict: "low_traffic", why: `0 conversions, but only ${a.campaign_clicks_14d} clicks in ${BIDDING_WINDOW_DAYS} days` };
  }
  if (a.upload_owned_elsewhere && !a.upload) {
    return { verdict: "unknown", why: `0 conversions on ${a.campaign_clicks_14d} clicks; the action belongs to another Google Ads account, whose upload summary is not readable from here` };
  }
  const upload = a.upload
    ? a.upload.last_upload_at ? `; last upload Google saw: ${a.upload.last_upload_at}` : "; Google has no recent upload for it"
    : "";
  return { verdict: "dark", why: `0 conversions in ${BIDDING_WINDOW_DAYS} days on ${a.campaign_clicks_14d} clicks${upload}` };
}

export function judgeBiddingTracking(actions: BiddingAction[], bidMapComplete: boolean, uploadRead: "ok" | "failed", now: Date = new Date()): BiddingTracking {
  const base = { actions, window_days: BIDDING_WINDOW_DAYS, upload_summary_read: uploadRead, since: null, since_is_lower_bound: false };
  if (actions.length === 0) {
    return bidMapComplete
      ? { ...base, verdict: "no_bidding_action", note: "No campaign bids on a conversion action, so Google is not optimising for any conversion." }
      : { ...base, verdict: "unknown", note: null };
  }
  const bad = actions.filter((a) => a.verdict === "dark" || a.verdict === "uploads_failing");
  if (bad.length > 0) {
    const named = bad.map((a) => `"${a.name ?? a.resource_name}" (${a.why})`).join("; ");
    const blind = actions.every((a) => a.conversions_14d === 0);
    const uploads = bad.map((a) => a.upload?.last_upload_at?.slice(0, 10)).filter((d): d is string => !!d).sort();
    const windowStart = new Date(now.getTime() - BIDDING_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
    return {
      ...base,
      since: uploads[0] ?? windowStart,
      since_is_lower_bound: uploads.length === 0,
      verdict: "broken",
      note: `${blind ? "Google is bidding blind" : "Part of what Google bids on is not recording"}: ${named}. Fix the conversion tracking or the uploads; Zavi changes no spend because of this.`,
    };
  }
  if (!bidMapComplete || actions.some((a) => a.verdict === "unknown")) {
    const unsure = actions.filter((a) => a.verdict === "unknown").map((a) => `"${a.name ?? a.resource_name}" (${a.why})`);
    return { ...base, verdict: "unknown", note: unsure.length ? `Could not judge: ${unsure.join("; ")}.` : null };
  }
  if (actions.some((a) => a.verdict === "warming_up") && !actions.some((a) => a.verdict === "recording")) {
    return { ...base, verdict: "warming_up", note: "Uploads to Google started recently; conversions may take several days to show. Check again next week." };
  }
  return { ...base, verdict: "ok", note: null };
}

export async function readBiddingTracking(
  search: GoogleAdsSearch,
  actions: ReadonlyArray<{ id: string | null; resource_name: string | null; name: string | null; status: string | null; type?: string | null }>,
  bidding: ReadonlyMap<string, CampaignRef[]>,
  complete: boolean,
  now: Date = new Date(),
): Promise<BiddingTracking> {
  const bidOn = actions.filter((a) => a.status === "ENABLED" && a.resource_name && (bidding.get(a.resource_name)?.length ?? 0) > 0);
  if (bidOn.length === 0) return judgeBiddingTracking([], complete, "ok", now);
  const [conv, clicks, uploads] = await Promise.allSettled([
    search(`SELECT segments.conversion_action, metrics.all_conversions FROM customer WHERE segments.date DURING LAST_14_DAYS LIMIT 10000`),
    search(`SELECT campaign.resource_name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_14_DAYS AND campaign.status != 'REMOVED' LIMIT 10000`),
    search(
      `SELECT offline_conversion_upload_conversion_action_summary.conversion_action_id, offline_conversion_upload_conversion_action_summary.status, offline_conversion_upload_conversion_action_summary.successful_event_count, offline_conversion_upload_conversion_action_summary.total_event_count, offline_conversion_upload_conversion_action_summary.pending_event_count, offline_conversion_upload_conversion_action_summary.last_upload_date_time, offline_conversion_upload_conversion_action_summary.daily_summaries, offline_conversion_upload_conversion_action_summary.alerts FROM offline_conversion_upload_conversion_action_summary`,
    ),
  ]);
  const convRows = conv.status === "fulfilled" ? (conv.value as Array<{ segments?: { conversionAction?: string }; metrics?: { allConversions?: unknown } }>) : null;
  const convComplete = convRows !== null && convRows.length < 10000;
  const convBy = new Map<string, number>();
  for (const r of convRows ?? []) {
    const k = r.segments?.conversionAction;
    if (k) convBy.set(k, (convBy.get(k) ?? 0) + (num(r.metrics?.allConversions) ?? 0));
  }
  const clickRows = clicks.status === "fulfilled" ? (clicks.value as Array<{ campaign?: { resourceName?: string }; metrics?: { clicks?: unknown } }>) : null;
  const clicksBy = new Map<string, number>();
  for (const r of clickRows ?? []) {
    const k = r.campaign?.resourceName?.split("/").at(-1);
    if (k) clicksBy.set(k, (clicksBy.get(k) ?? 0) + (num(r.metrics?.clicks) ?? 0));
  }
  const servingCustomers = new Set((clickRows ?? []).map((r) => r.campaign?.resourceName?.split("/")[1]).filter((x): x is string => !!x));
  const uploadBy = uploads.status === "fulfilled" ? mergeUploadRows(uploads.value as UploadRow[], now) : new Map<string, UploadSummary>();
  const judged = bidOn.map((a) => {
    const campaigns = bidding.get(a.resource_name!)!;
    const row = {
      resource_name: a.resource_name!,
      name: a.name,
      campaigns,
      conversions_14d: convComplete ? convBy.get(a.resource_name!) ?? 0 : (convBy.get(a.resource_name!) ?? 0) > 0 ? convBy.get(a.resource_name!)! : null,
      campaign_clicks_14d: clickRows === null || clickRows.length >= 10000
        ? null
        : campaigns.reduce((sum, c) => sum + (c.campaign_id ? clicksBy.get(c.campaign_id) ?? 0 : 0), 0),
      upload: a.id ? uploadBy.get(a.id) ?? null : null,
      upload_read_failed: uploads.status === "rejected",
      upload_owned_elsewhere: OFFLINE_UPLOAD_TYPES.has(a.type ?? "") && servingCustomers.size > 0 && !servingCustomers.has(a.resource_name!.split("/")[1] ?? ""),
    };
    return { ...row, ...judgeAction(row, now) };
  });
  return judgeBiddingTracking(judged, complete, uploads.status === "fulfilled" ? "ok" : "failed", now);
}

export type TrackingVerdict = { status: BiddingVerdict; reason: string | null; since: string | null; since_is_lower_bound: boolean };

export function trackingVerdictOf(b: BiddingTracking): TrackingVerdict {
  return { status: b.verdict, reason: b.note, since: b.since, since_is_lower_bound: b.since_is_lower_bound };
}
