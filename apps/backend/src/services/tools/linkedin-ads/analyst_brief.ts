import { z } from "zod";
import { readLinkedInAdAnalytics, readLinkedInAdAnalyticsWithToken, type AdAnalyticsRow } from "@/services/connectors/linkedin-ads/client";
import { buildBriefs, type BriefThresholds, type CampaignBrief, type Posture } from "@/services/growth/perf-brief/brief";
import type { ToolSpec } from "@/services/tools/types";
import { linkedinAccountAccess } from "./_wallet";
import { fetchLinkedInDailySeries, LINKEDIN_CAMPAIGN_GROUP_URN, LINKEDIN_CAMPAIGN_URN, LINKEDIN_FX_NOTE, LINKEDIN_PARTIAL_NOTE, type LinkedInDailyLevel, type LinkedInDailyRow } from "./daily_series";
import { PAUSE_NOTE, pauseSignals, trackingHistory, type PauseSignal, type ReadRows } from "./read_analytics";

export const LINKEDIN_BRIEF_THRESHOLDS: BriefThresholds = {
  min_clicks: 21,
  min_spend_usd: 70,
  min_results_for_call: 10,
  results: "conversions",
};

const GUARDED: ReadonlySet<PauseSignal> = new Set(["metrics_unread", "tracking_unverified", "tracking_history_unread"]);
const WINDOW_METRICS = ["impressions", "clicks", "spend", "conversions", "leads"] as const;
const GRADED_METRICS: ReadonlySet<string> = new Set(["spend", "impressions", "clicks", "conversions", "leads"]);

export const LINKEDIN_BRIEF_FX_NOTE =
  "No exchange rate was available for this account's currency, so spend in USD is unknown and the spend floor cannot be checked. No posture is given; spend in the account currency is in settled_window.spend and in linkedin_ads_daily_series.";

const entityKey = (r: Pick<LinkedInDailyRow, "campaign_id" | "ad_set_id">) => `${r.campaign_id}:${r.ad_set_id ?? ""}`;
const pivotOf = (level: LinkedInDailyLevel, b: Pick<CampaignBrief, "campaign_id" | "ad_set_id">) =>
  level === "campaign" ? `${LINKEDIN_CAMPAIGN_URN}${b.ad_set_id ?? ""}` : `${LINKEDIN_CAMPAIGN_GROUP_URN}${b.campaign_id}`;

export function wholeWindowRows(level: LinkedInDailyLevel, rows: LinkedInDailyRow[]): AdAnalyticsRow[] {
  const byEntity = new Map<string, LinkedInDailyRow[]>();
  for (const r of rows) {
    const k = entityKey(r);
    if (!byEntity.has(k)) byEntity.set(k, []);
    byEntity.get(k)!.push(r);
  }
  return [...byEntity.values()].map((rs) => {
    const sum = (pick: (r: LinkedInDailyRow) => number | null) => (rs.some((r) => pick(r) === null) ? null : rs.reduce((t, r) => t + (pick(r) as number), 0));
    const values = {
      impressions: sum((r) => r.impressions),
      clicks: sum((r) => r.clicks),
      spend: sum((r) => r.spend),
      conversions: sum((r) => r.website_conversions),
      leads: sum((r) => r.leads),
    };
    return {
      pivot: pivotOf(level, rs[0]),
      impressions: values.impressions ?? 0,
      clicks: values.clicks ?? 0,
      spend: values.spend ?? 0,
      conversions: values.conversions ?? 0,
      leads: values.leads ?? 0,
      missing_metrics: WINDOW_METRICS.filter((m) => values[m] === null),
    };
  });
}

export type LinkedInBrief = {
  campaign_group_id: string;
  campaign_group_name: string;
  ad_set_id: string | null;
  ad_set_name: string | null;
  funnel_diagnosis: CampaignBrief["funnel_label"];
  recommended_posture: Posture;
  judged_on: CampaignBrief["judged_on"];
  confidence: CampaignBrief["confidence"];
  settled_through: string;
  maturing_days_excluded: number;
  settled_window: CampaignBrief["settled"];
  prior_window: CampaignBrief["prior"];
  pause_signal: PauseSignal | null;
  unread_metrics: string[];
  notes: string[];
};

const CUT_NOTE =
  "Enough settled clicks and spend, a healthy CTR and no website conversion or lead-form lead in the whole window, while this line has shown results in the last year, so its tracking works. A pause for waste may be proposed, citing these numbers.";

export const LINKEDIN_TRUNCATED_NOTE =
  "PARTIAL DATA — LinkedIn did not return the whole window, so postures are suppressed. Re-read a NARROWER scope (a shorter window, or one campaign at a time) before any scale or cut decision.";

export function gradeLinkedInBriefs(
  level: LinkedInDailyLevel,
  briefs: CampaignBrief[],
  rows: LinkedInDailyRow[],
  signals: Map<string, PauseSignal>,
  truncated: boolean,
  fxUnavailable = false,
): LinkedInBrief[] {
  return briefs.map((b) => {
    const own = rows.filter((r) => entityKey(r) === entityKey(b));
    const unread = [...new Set(own.flatMap((r) => r.missing_metrics.filter((m) => GRADED_METRICS.has(m))))];
    const signal = signals.get(pivotOf(level, b)) ?? null;
    const guarded = signal !== null && GUARDED.has(signal);
    const suppressed = truncated || unread.length > 0 || guarded || fxUnavailable;
    const cut = !suppressed && signal === "pause_candidate" && b.funnel_label === "click_no_convert" && b.judged_on !== "reach_and_clicks";
    const notes = truncated
      ? [LINKEDIN_TRUNCATED_NOTE]
      : [
          ...(unread.length
            ? [
                `LinkedIn left ${unread.join(", ")} out of ${own.filter((r) => r.missing_metrics.some((m) => GRADED_METRICS.has(m))).length} of ${own.length} day(s) for this line. A missing number is unknown, not zero, so no posture is given; say the days are unread rather than calling them zero.`,
              ]
            : []),
          ...(fxUnavailable ? [LINKEDIN_BRIEF_FX_NOTE] : []),
          ...(guarded && signal ? [PAUSE_NOTE[signal]] : []),
          ...(cut ? [CUT_NOTE] : []),
          ...b.notes,
        ];
    return {
      campaign_group_id: b.campaign_id,
      campaign_group_name: b.campaign_name,
      ad_set_id: b.ad_set_id,
      ad_set_name: b.ad_set_name,
      funnel_diagnosis: suppressed ? "maturing_insufficient" : b.funnel_label,
      recommended_posture: suppressed ? "NO_DECISION" : cut ? "CUT_CANDIDATE" : b.posture,
      judged_on: b.judged_on,
      confidence: suppressed ? "inadequate" : b.confidence,
      settled_through: b.settled_cutoff,
      maturing_days_excluded: b.maturing_days,
      settled_window: b.settled,
      prior_window: b.prior,
      pause_signal: signal,
      unread_metrics: unread,
      notes,
    };
  });
}

async function windowSignals(tenant_id: string, account_id: string, level: LinkedInDailyLevel, rows: LinkedInDailyRow[], end: Date): Promise<Map<string, PauseSignal>> {
  const whole = wholeWindowRows(level, rows);
  if (!whole.length) return new Map();
  const access = await linkedinAccountAccess(tenant_id, account_id);
  const pivot = level === "campaign" ? "CAMPAIGN" : "CAMPAIGN_GROUP";
  const read: ReadRows =
    access.kind === "wallet"
      ? async (o) => {
          const urns = (o.campaigns ?? access.campaignUrns).filter((u) => access.campaignUrns.includes(u));
          if (!urns.length) return [];
          const raw = await readLinkedInAdAnalyticsWithToken(access.token, account_id, { ...o, pivot: "CAMPAIGN", campaigns: urns });
          return raw.filter((r) => r.pivot !== null && urns.includes(r.pivot));
        }
      : (o) => readLinkedInAdAnalytics(tenant_id, account_id, o);
  const historyUsable = level === "campaign" || access.kind !== "wallet";
  const { history, historyRead } = historyUsable ? await trackingHistory(read, whole, pivot, end) : { history: [], historyRead: false };
  const { signals } = pauseSignals(whole, history, historyRead);
  return new Map(whole.map((r, i) => [r.pivot as string, signals[i]]));
}

export async function linkedinBriefs(tenant_id: string, opts: { account_id: string; level: LinkedInDailyLevel; lookback_days: number; campaign_id?: string }, now = new Date()) {
  const series = await fetchLinkedInDailySeries(tenant_id, opts);
  const briefs = buildBriefs(series.rows, now, undefined, LINKEDIN_BRIEF_THRESHOLDS);
  const signals = series.truncated ? new Map<string, PauseSignal>() : await windowSignals(tenant_id, opts.account_id, opts.level, series.rows, now);
  return { series, briefs: gradeLinkedInBriefs(opts.level, briefs, series.rows, signals, series.truncated, series.fx_unavailable) };
}

const inputSchema = z
  .object({
    account_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[1-9]\d*$/, "account_id must be a numeric LinkedIn ad-account id")
      .describe("LinkedIn Ads account id, from linkedin_ads_list_accounts."),
    level: z
      .enum(["campaign_group", "campaign"])
      .default("campaign")
      .describe("Brief granularity: per LinkedIn campaign (ad set, default) or per campaign group."),
    lookback_days: z.number().int().min(14).max(90).default(30),
  })
  .strict();

export const linkedinAdsAnalystBriefTool: ToolSpec = {
  name: "linkedin_ads_analyst_brief",
  effect: "read",
  description:
    "Senior-analyst brief per LinkedIn campaign (ad set) or campaign group, computed from DAILY data. For each line it returns a SETTLED-window read (the last ~3 days are excluded because conversions lag the click), a FUNNEL DIAGNOSIS and a recommended POSTURE: SCALE / HOLD / INVESTIGATE_FUNNEL / CUT_CANDIDATE / NO_DECISION. Results = website conversions + lead-form leads. A line whose tracking is unverified, whose numbers LinkedIn left out, or whose objective buys reach and clicks is NO_DECISION, never CUT_CANDIDATE. Call this BEFORE any pause or budget decision instead of judging one 30-day aggregate; linkedin_ads_propose_pause_campaign accepts a CUT_CANDIDATE line. Read-only.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { account_id, level, lookback_days } = inputSchema.parse(input);
    const { series, briefs } = await linkedinBriefs(ctx.tenant_id, { account_id, level, lookback_days });
    return {
      account_id,
      currency: series.currency,
      level,
      time_range: series.time_range,
      briefs,
      truncated: series.truncated,
      ...(series.truncated
        ? {
            read_through: series.read_through,
            partial_reason: series.partial_reason,
            warning: `data_incomplete_truncated — postures suppressed to NO_DECISION. ${series.partial_reason ? LINKEDIN_PARTIAL_NOTE[series.partial_reason] : ""}`.trim(),
          }
        : {}),
      ...(series.fx_unavailable ? { fx_note: LINKEDIN_FX_NOTE } : {}),
      thresholds: LINKEDIN_BRIEF_THRESHOLDS,
      as_of: new Date().toISOString().slice(0, 10),
      method:
        "Settled window excludes the last ~72h (conversion lag) and is judged on the last 7 settled days against the 7 before. settled_window money is in USD at Zavi's daily rate; spend in the account currency is in linkedin_ads_daily_series. Confidence needs at least thresholds.min_clicks clicks and thresholds.min_spend_usd of spend in the settled week; a line below that is NO_DECISION. INVESTIGATE_FUNNEL = the ad is working and the leak is below the click; do not cut. A null day is unknown, not zero.",
    };
  },
};
