
import { z } from "zod";
import { fbGet, fbGetAllPages, metaAdsCreds, metaActionValue, metaDateRange } from "./_client";
import type { ToolSpec } from "@/services/tools/types";
import { buildTotals } from "@/services/tools/_shared/totals";
import { buildWaste } from "@/services/tools/_shared/waste";
import { minorToMajor } from "./write/_currency";
import { DEFAULT_LAG_HOURS } from "@/services/growth/perf-brief/brief";

const DAY_MS = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function settledThroughDate(now: Date, lagHours: number = DEFAULT_LAG_HOURS): string {
  const cutoff = ymd(new Date(now.getTime() - lagHours * 3_600_000));
  return ymd(new Date(Date.parse(`${cutoff}T00:00:00Z`) - DAY_MS));
}

export function settledWindow(preset: string, now: Date): { since: string; until: string } {
  const through = settledThroughDate(now);
  const days = ({ last_7d: 7, last_14d: 14, last_28d: 28, last_30d: 30 } as Record<string, number>)[preset];
  if (days) return { since: ymd(new Date(Date.parse(`${through}T00:00:00Z`) - (days - 1) * DAY_MS)), until: through };
  const w = metaDateRange(preset, now);
  return through < w.until && through >= w.since ? { since: w.since, until: through } : w;
}

const inputSchema = z.object({
  campaign_id: z.string().min(1).optional(),
  date_preset: z
    .enum([
      "last_7d",
      "last_14d",
      "last_28d",
      "last_30d",
      "this_month",
      "last_month",
    ])
    .optional(),
  time_range: z
    .object({
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .optional(),
});

type InsightRow = {
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  reach?: string;
  actions?: Array<{ action_type?: string; value?: string }>;
  action_values?: Array<{ action_type?: string; value?: string }>;
};

type AdSetDetail = {
  daily_budget?: string | null;
  learning_stage_info?: { status?: string } | null;
  updated_time?: string | null;
  lifetime_budget?: string | null;
  status?: string;
  configured_status?: string;
  effective_status?: string;
  optimization_goal?: string;
  start_time?: string | null;
  end_time?: string | null;
  ads?: { summary?: { total_count?: number } } | null;
  bid_strategy?: string | null;
  bid_amount?: string | null;
  attribution_spec?: Array<{
    event_type?: string;
    window_days?: number;
  }> | null;
  promoted_object?: {
    custom_event_type?: string;
    pixel_id?: string;
    custom_conversion_id?: string;
  } | null;
  targeting?: {
    geo_locations?: unknown;
    age_min?: number;
    age_max?: number;
    genders?: number[];
    flexible_spec?: unknown;
    custom_audiences?: Array<{ id?: string; name?: string }>;
    excluded_custom_audiences?: Array<{ id?: string; name?: string }>;
    publisher_platforms?: string[];
    facebook_positions?: string[];
    instagram_positions?: string[];
    device_platforms?: string[];
    targeting_automation?: { advantage_audience?: number };
  };
};

export type TargetingSentence = { content: string; children: string[] };

const DETAIL_FIELDS =
  "daily_budget,lifetime_budget,status,configured_status,effective_status,optimization_goal,start_time,end_time," +
  "ads.limit(0).summary(true)," +
  "bid_strategy,bid_amount,attribution_spec,learning_stage_info,updated_time," +
  "promoted_object{custom_event_type,pixel_id,custom_conversion_id}," +
  "targeting{geo_locations,age_min,age_max,genders,flexible_spec,custom_audiences," +
  "excluded_custom_audiences,publisher_platforms,facebook_positions,instagram_positions," +
  "device_platforms,targeting_automation}";

const META_EVENT_LABEL: Record<string, string> = {
  PURCHASE: "Purchase",
  INITIATED_CHECKOUT: "InitCheckout",
  INITIATE_CHECKOUT: "InitCheckout",
  COMPLETE_REGISTRATION: "Signup",
  LEAD: "Lead",
  CONTACT: "Contact",
  SUBMIT_APPLICATION: "Apply",
  ADD_TO_CART: "AddToCart",
  ADD_PAYMENT_INFO: "AddPayment",
  SEARCH: "Search",
  VIEW_CONTENT: "ViewContent",
  START_TRIAL: "Trial",
  SUBSCRIBE: "Subscribe",
  SCHEDULE: "Schedule",
};
const META_OPT_GOAL_LABEL: Record<string, string> = {
  LINK_CLICKS: "Clicks",
  LANDING_PAGE_VIEWS: "LPViews",
  REACH: "Reach",
  IMPRESSIONS: "Impr",
  POST_ENGAGEMENT: "Engage",
  THRUPLAY: "ThruPlay",
  OFFSITE_CONVERSIONS: "Conversion",
  QUALITY_LEAD: "QualLead",
};

export function metaOptimizationEvent(detail: AdSetDetail): string | null {
  const evt = detail.promoted_object?.custom_event_type;
  if (evt) return META_EVENT_LABEL[evt] ?? titleCaseEnum(evt);
  const goal = detail.optimization_goal;
  if (goal) return META_OPT_GOAL_LABEL[goal] ?? titleCaseEnum(goal);
  return null;
}

function titleCaseEnum(s: string): string {
  return s
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export const metaListAdSetsTool: ToolSpec = {
  name: "meta_ads_list_ad_sets",
  effect: "read",
  description:
    "List ad sets within a Meta Ads campaign with performance metrics PLUS targeting.geo_locations, daily_budget_usd, status, optimization_goal, optimization_event (the REAL conversion event — Purchase / InitiateCheckout / Signup — that disambiguates ad sets sharing the coarse optimization_goal=OFFSITE_CONVERSIONS), learning (Meta's learning phase) and days_since_edit. The budget + targeting fields are what propose_budget_change needs for drift detection and what geo-scoped operator questions need for verification. With no window given, metrics end at settled_through (the same settled day as analyst_brief), so recent conversions still coming in are not read as a drop.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const parsed = inputSchema.parse(input);
    const { campaign_id } = parsed;
    const now = new Date();
    const settled_through = settledThroughDate(now);
    const { since, until } =
      parsed.time_range ?? (parsed.date_preset === undefined ? settledWindow("last_30d", now) : metaDateRange(parsed.date_preset, now));
    const creds = await metaAdsCreds(ctx.tenant_id);

    const params: Record<string, string | number | undefined> = {
      level: "adset",
      time_range: JSON.stringify({ since, until }),
      time_increment: "all_days",
      limit: 200,
      fields:
        "adset_id,adset_name,campaign_id,spend,impressions,clicks,ctr,cpc,cpm,reach,actions,action_values",
    };
    if (campaign_id) {
      params.filtering = JSON.stringify([
        { field: "campaign.id", operator: "EQUAL", value: campaign_id },
      ]);
    }

    const j = (await fbGet(
      ctx.tenant_id,
      `${creds.ad_account_id}/insights`,
      params,
    )) as {
      data?: InsightRow[];
      paging?: { next?: string };
    };
    const insightRows = j.data ?? [];
    const insightsComplete = !j.paging?.next;

    const enumerated = campaign_id
      ? await enumerateCampaignAdSets(ctx.tenant_id, campaign_id)
      : await enumerateAccountAdSets(ctx.tenant_id, creds.ad_account_id);
    const insightIds = new Set(
      insightRows.map((row) => row.adset_id).filter(Boolean),
    );
    for (const adSet of enumerated) {
      if (!adSet.id || insightIds.has(adSet.id)) continue;
      insightRows.push({
        adset_id: adSet.id,
        adset_name: adSet.name ?? "",
        campaign_id: adSet.campaign_id ?? campaign_id ?? "",
      });
    }

    const ids = insightRows
      .map((r) => r.adset_id)
      .filter((id): id is string => Boolean(id));
    const detailMap = await fetchAdSetDetails(ctx.tenant_id, ids);

    let currency: string | null = null;
    if (ids.length > 0) {
      try {
        const acctResp = (await fbGet(ctx.tenant_id, creds.ad_account_id, {
          fields: "currency",
        })) as { currency?: string };
        currency = acctResp.currency ?? null;
      } catch {
        currency = null;
      }
    }

    const ad_sets = mergeAdSetDetails(insightRows, detailMap, currency, now);
    return {
      waste: buildWaste(ad_sets, {
        labelFields: ["ad_set_name"],
        spendField: "spend_usd",
        conversionFields: ["conversions", "leads"],
        outcomeLabel: "sales, signups or leads",
        window: `${since}..${until}`,
        entity: "ad sets",
        complete: insightsComplete,
        currency: currency ?? "account currency",
      }),
      totals: buildTotals(ad_sets, {
        sum: ["spend_usd", "impressions", "clicks", "conversions", "purchases", "leads", "purchase_value_usd"],
        ratios: {
          roas: ["purchase_value_usd", "spend_usd"],
          cpa_usd: ["spend_usd", "conversions"],
          ctr_percent: ["clicks", "impressions"],
        },
        scope: `${ad_sets.length} ad sets · ${since}..${until}`,
        complete: insightsComplete,
        note: insightsComplete ? undefined : "One API page only (limit 200); more rows exist. These are PAGE totals, not account totals.",
      }),
      ad_sets,
      campaign_id: campaign_id ?? null,
      time_range: { since, until },
      settled_through,
      currency,
      ad_account_id: creds.ad_account_id,
    };
  },
};

async function fetchAdSetDetails(
  tenant_id: string,
  ids: string[],
): Promise<Record<string, AdSetDetail>> {
  if (ids.length === 0) return {};
  const resp = (await fbGet(tenant_id, "", {
    ids: ids.join(","),
    fields: DETAIL_FIELDS,
  })) as Record<string, AdSetDetail>;
  return resp ?? {};
}

export function mergeAdSetDetails(
  insightRows: InsightRow[],
  detailMap: Record<string, AdSetDetail>,
  currency: string | null,
  now: Date = new Date(),
): Array<Record<string, unknown>> {
  return insightRows.map((r) => {
    const spend = Number(r.spend ?? 0);
    const purchases = metaActionValue(r.actions, "purchase");
    const checkouts = metaActionValue(r.actions, "initiate_checkout");
    const regs =
      metaActionValue(r.actions, "complete_registration") ||
      metaActionValue(
        r.actions,
        "offsite_conversion.fb_pixel_complete_registration",
      );
    const leads =
      metaActionValue(r.actions, "lead") ||
      metaActionValue(r.actions, "offsite_conversion.fb_pixel_lead");
    const conv = purchases + checkouts + regs;
    const purchaseValue = metaActionValue(r.action_values, "purchase");
    const detail = detailMap[r.adset_id ?? ""] ?? {};

    const dailyMinor = detail.daily_budget;
    const lifetimeMinor = detail.lifetime_budget;

    return {
      ad_set_id: r.adset_id ?? "",
      ad_set_name: r.adset_name ?? "",
      campaign_id: r.campaign_id ?? "",
      spend_usd: round2(spend),
      impressions: Number(r.impressions ?? 0),
      clicks: Number(r.clicks ?? 0),
      ctr_percent: round2(Number(r.ctr ?? 0)),
      cpc_usd: round2(Number(r.cpc ?? 0)),
      cpm_usd: round2(Number(r.cpm ?? 0)),
      reach: Number(r.reach ?? 0),
      conversions: round2(conv),
      purchases: round2(purchases),
      sign_ups: round2(regs),
      leads: round2(leads),
      purchase_value_usd: round2(purchaseValue),
      roas: spend > 0 ? round2(purchaseValue / spend) : null,
      cpa_usd: conv > 0 ? round2(spend / conv) : null,
      daily_budget_usd: minorToMajor(dailyMinor, currency),
      lifetime_budget_usd: minorToMajor(lifetimeMinor, currency),
      daily_budget_minor_units: dailyMinor ?? null,
      lifetime_budget_minor_units: lifetimeMinor ?? null,
      status: detail.status ?? null,
      configured_status: detail.configured_status ?? null,
      effective_status: detail.effective_status ?? null,
      start_time: detail.start_time ?? null,
      end_time: detail.end_time ?? null,
      ads_count: detail.ads?.summary?.total_count ?? null,
      optimization_goal: detail.optimization_goal ?? null,
      learning: detail.learning_stage_info?.status ? detail.learning_stage_info.status !== "SUCCESS" : null,
      learning_status: detail.learning_stage_info?.status ?? null,
      days_since_edit: daysSinceEdit(detail.updated_time, now),
      optimization_event: metaOptimizationEvent(detail),
      geo_locations: detail.targeting?.geo_locations ?? null,
      bid_strategy: detail.bid_strategy ?? null,
      bid_amount_usd: minorToMajor(detail.bid_amount, currency),
      attribution_window: formatAttributionWindow(detail.attribution_spec),
      pixel_id: detail.promoted_object?.pixel_id ?? null,
      custom_conversion_id:
        detail.promoted_object?.custom_conversion_id ?? null,
      age_min: detail.targeting?.age_min ?? null,
      age_max: detail.targeting?.age_max ?? null,
      genders: formatGenders(detail.targeting?.genders),
      custom_audiences: (detail.targeting?.custom_audiences ?? [])
        .map((a) => a?.name)
        .filter((n): n is string => typeof n === "string" && n.length > 0),
      excluded_custom_audiences: (
        detail.targeting?.excluded_custom_audiences ?? []
      )
        .map((a) => a?.name)
        .filter((n): n is string => typeof n === "string" && n.length > 0),
      placements: detail.targeting?.publisher_platforms ?? null,
      automatic_placements: detail.targeting?.publisher_platforms == null,
      advantage_audience:
        detail.targeting?.targeting_automation?.advantage_audience === 1,
    };
  });
}

function daysSinceEdit(iso: string | null | undefined, now: Date): number | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY_MS)) : null;
}

export function formatGenders(genders: number[] | undefined): string {
  if (!genders || genders.length === 0 || genders.length > 1)
    return "All genders";
  if (genders[0] === 1) return "Men";
  if (genders[0] === 2) return "Women";
  return "All genders";
}

export function formatAttributionWindow(
  spec: AdSetDetail["attribution_spec"],
): string | null {
  if (!spec || spec.length === 0) return null;
  const label: Record<string, string> = {
    CLICK_THROUGH: "click",
    VIEW_THROUGH: "view",
    ENGAGED_VIDEO_VIEW: "video view",
  };
  const parts = spec
    .filter((s) => s?.event_type && typeof s.window_days === "number")
    .map(
      (s) =>
        `${s.window_days}d ${label[s.event_type!] ?? titleCaseEnum(s.event_type!)}`,
    );
  return parts.length > 0 ? parts.join(" / ") : null;
}

export async function fetchTargetingSentences(
  tenant_id: string,
  ad_set_id: string,
): Promise<TargetingSentence[]> {
  try {
    const resp = (await fbGet(
      tenant_id,
      `${ad_set_id}/targetingsentencelines`,
      {},
    )) as {
      targetingsentencelines?: Array<{ content?: string; children?: unknown }>;
    };
    const lines = resp?.targetingsentencelines ?? [];
    return lines
      .filter((l) => typeof l?.content === "string" && l.content.length > 0)
      .map((l) => ({
        content: String(l.content),
        children: Array.isArray(l.children)
          ? l.children.map((c) => String(c))
          : [],
      }));
  } catch {
    return [];
  }
}

export function minorToUsd(minor: string | null | undefined): number | null {
  if (minor == null) return null;
  const n = Number(minor);
  if (!Number.isFinite(n) || n < 0) return null;
  return round2(n / 100);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type CampaignAdSet = {
  id?: string;
  name?: string;
  campaign_id?: string;
  daily_budget?: string | null;
  lifetime_budget?: string | null;
  effective_status?: string;
  configured_status?: string;
  status?: string;
  optimization_goal?: string;
};

const ADSET_ENUM_FIELDS =
  "id,name,campaign_id,daily_budget,lifetime_budget,effective_status,configured_status,status,optimization_goal";

export async function enumerateAccountAdSets(
  tenant_id: string,
  ad_account_id: string,
): Promise<CampaignAdSet[]> {
  const rows = await fbGetAllPages<CampaignAdSet>(tenant_id, `${ad_account_id}/adsets`, {
    fields: ADSET_ENUM_FIELDS,
    limit: 200,
  });
  return rows.filter((adSet) => !isExcluded(adSet));
}

export async function enumerateCampaignAdSets(
  tenant_id: string,
  campaign_id: string,
): Promise<CampaignAdSet[]> {
  const resp = (await fbGet(tenant_id, `${campaign_id}/adsets`, {
    fields: ADSET_ENUM_FIELDS,
    limit: 200,
  })) as { data?: CampaignAdSet[]; paging?: { next?: string } };
  if (resp.paging?.next) {
    throw new Error(
      "campaign_adset_enumeration_incomplete: campaign has more ad sets than a single page; refusing to resolve a single budget target",
    );
  }
  return resp.data ?? [];
}

const EXCLUDED_STATUSES = new Set(["DELETED", "ARCHIVED"]);

function isExcluded(a: CampaignAdSet): boolean {
  const eff = (a.effective_status ?? "").toUpperCase();
  const cfg = (a.configured_status ?? a.status ?? "").toUpperCase();
  return EXCLUDED_STATUSES.has(eff) || EXCLUDED_STATUSES.has(cfg);
}

function hasAdSetDailyBudget(a: CampaignAdSet): boolean {
  const n = Number(a.daily_budget);
  return a.daily_budget != null && Number.isFinite(n) && n > 0;
}

export type BudgetingClassification =
  | { kind: "single"; adSet: CampaignAdSet }
  | { kind: "cbo_or_none" }
  | { kind: "ambiguous" };

export function classifyCampaignBudgeting(
  adSets: CampaignAdSet[],
): BudgetingClassification {
  const live = adSets.filter(
    (a) => !isExcluded(a) && typeof a.id === "string" && a.id.length > 0,
  );
  const budgeted = live.filter(hasAdSetDailyBudget);
  if (budgeted.length === 1) return { kind: "single", adSet: budgeted[0]! };
  if (budgeted.length === 0) return { kind: "cbo_or_none" };
  return { kind: "ambiguous" };
}
