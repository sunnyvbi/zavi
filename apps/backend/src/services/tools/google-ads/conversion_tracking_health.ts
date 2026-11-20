
import { z } from "zod";
import { createGoogleAdsReadSession } from "./_client";
import { readConversionGoals, type CampaignRef } from "./_conversion-goals";
import { readBiddingTracking, trackingVerdictOf } from "./_bidding-tracking";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  campaign_id: z.string().regex(/^\d+$/).optional(),
  date_range: z
    .enum(["LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS"])
    .default("LAST_30_DAYS"),
});

type ConvActionRow = {
  conversionAction?: {
    id?: string;
    resourceName?: string;
    countingType?: string;
    origin?: string;
    name?: string;
    status?: string;
    type?: string;
    category?: string;
    primaryForGoal?: boolean;
    includeInConversionsMetric?: boolean;
  };
};

type ActionHealth = {
  id: string | null;
  resource_name: string | null;
  counting_type: string | null;
  origin: string | null;
  name: string | null;
  status: string | null;
  type: string | null;
  category: string | null;
  primary_for_goal: boolean | null;
  in_conversions_column: boolean | null;
  used_by_campaigns: CampaignRef[] | null;
  conversions_in_window: number | null;
  all_conversions_in_window: number | null;
};

export type GoogleTrackingOverall =
  | "unknown"
  | "healthy"
  | "stale"
  | "misconfigured"
  | "no_conversion_actions";

export const conversionTrackingHealthTool: ToolSpec = {
  name: "google_ads_conversion_tracking_health",
  effect: "read",
  description:
    "Conversion-tracking check for the tenant's Google Ads account. Call this BEFORE trusting Google ROAS / conversion / CPA numbers. Optional campaign_id scopes goal detail only. Goal output omits removed campaigns and known non-biddable action rows and flags truncation. Lists the account's conversion actions (status, type, category, counting_type and origin) plus per-campaign standard/custom goal biddability and how many conversions each RECORDED in the window. Each action carries in_conversions_column and used_by_campaigns (campaigns whose goals select it, named; null = unresolved, and always null when campaign_id is set). tracking_verdict (status broken / warming_up / ok / no_bidding_action / unknown, reason, since) judges the actions campaigns BID on (14-day conversions, clicks, offline upload summary); read it first. overall_status is account-wide recording only: unknown (recording cannot be established) / healthy (recording observed; metadata may still be incomplete) / stale (ENABLED actions but no recent conversions — tag/gtag may not be firing) / misconfigured (actions exist but none ENABLED) / no_conversion_actions (nothing set up). Always includes a plain-language `suggestion` for fixing setup when it isn't healthy. Does not inspect live gtag/GTM firing or Enhanced Conversions. Throws google_ads_not_connected if OAuth + developer-token aren't wired.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { date_range, campaign_id } = inputSchema.parse(input);
    const search = createGoogleAdsReadSession(ctx.tenant_id);

    const query = `
      SELECT
        conversion_action.id,
        conversion_action.resource_name,
        conversion_action.counting_type,
        conversion_action.origin,
        conversion_action.name,
        conversion_action.status,
        conversion_action.type,
        conversion_action.category,
        conversion_action.primary_for_goal,
        conversion_action.include_in_conversions_metric
      FROM conversion_action
      LIMIT 10000
    `;
    const rows = (await search(query)) as ConvActionRow[];

    const metricRows = await search(`SELECT segments.conversion_action, metrics.conversions, metrics.all_conversions FROM customer WHERE segments.date DURING ${date_range} LIMIT 10000`) as { segments?: { conversionAction?: string }; metrics?: { conversions?: number | string; allConversions?: number | string } }[];
    const metrics = new Map(metricRows.map((row) => [row.segments?.conversionAction, row.metrics]));
    const metricsComplete = metricRows.length < 10000;
    const countFor = (resource: string | undefined, key: "conversions" | "allConversions") => {
      if (!resource || (!metrics.has(resource) && !metricsComplete)) return null;
      const value = Number(metrics.get(resource)?.[key] ?? 0);
      return Number.isFinite(value) ? value : null;
    };
    const actions: ActionHealth[] = rows.map((r) => ({
      id: r.conversionAction?.id ?? null,
      resource_name: r.conversionAction?.resourceName ?? null,
      counting_type: r.conversionAction?.countingType ?? null,
      origin: r.conversionAction?.origin ?? null,
      name: r.conversionAction?.name ?? null,
      status: r.conversionAction?.status ?? null,
      type: r.conversionAction?.type ?? null,
      category: r.conversionAction?.category ?? null,
      primary_for_goal: r.conversionAction?.primaryForGoal ?? null,
      in_conversions_column: r.conversionAction?.includeInConversionsMetric ?? null,
      used_by_campaigns: null,
      conversions_in_window: countFor(r.conversionAction?.resourceName, "conversions"),
      all_conversions_in_window: countFor(r.conversionAction?.resourceName, "allConversions"),
    }));

    const inventoryComplete = rows.length < 10000;
    const knownActions = new Set(actions.map((action) => action.resource_name));
    const unobservedMetricActions = [...new Set(metricRows.map((row) => row.segments?.conversionAction).filter((resource): resource is string => typeof resource === "string" && resource.length > 0 && !knownActions.has(resource)))];
    const enabled = actions.filter((a) => a.status === "ENABLED");
    const externalCounts = unobservedMetricActions.map((resource) => countFor(resource, "allConversions"));
    const externallyRecorded = externalCounts.some((count) => count === null) ? null : externalCounts.reduce<number>((sum, count) => sum + (count ?? 0), 0);
    const recentConversions = !inventoryComplete || !metricsComplete || externallyRecorded === null || enabled.some((action) => action.all_conversions_in_window === null)
      ? null : enabled.reduce((sum, action) => sum + (action.all_conversions_in_window ?? 0), 0) + externallyRecorded;
    const recordingObserved = enabled.some((action) => (action.all_conversions_in_window ?? 0) > 0) || externalCounts.some((count) => (count ?? 0) > 0);
    let overall_status: GoogleTrackingOverall;
    let suggestion: string;
    if (recordingObserved) {
      overall_status = "healthy";
      suggestion = "Conversion recording is observed in the window, including manager-owned actions where present. This does not confirm trigger correctness or complete goal configuration; inspect action inventory and campaign_goals separately.";
    } else if (!inventoryComplete || unobservedMetricActions.length > 0 || actions.some((action) => action.status === null)) {
      overall_status = "unknown";
      suggestion = "Action inventory is incomplete or includes unknown statuses; verify the conversion-owning account before concluding no active action exists.";
    } else if (actions.length === 0) {
      overall_status = "no_conversion_actions";
      suggestion =
        "No conversion actions are set up in this Google Ads account, so ROAS / CPA / conversion numbers cannot be tracked. Set up at least one conversion action (e.g. a Purchase/Booking action via the Google tag or GA4 import) and mark it primary-for-goal.";
    } else if (enabled.length === 0) {
      overall_status = "misconfigured";
      suggestion =
        "Conversion actions exist but none are ENABLED (they are REMOVED/HIDDEN), so Google has no active conversion to optimize toward. Enable a primary conversion action in Google Ads → Goals → Conversions.";
    } else if (recentConversions === null) {
      overall_status = "unknown";
      suggestion = "Recording recency could not be verified from the available metrics; missing or capped data is not zero conversions.";
    } else if (recentConversions === 0) {
      overall_status = "stale";
      suggestion = `There ${enabled.length === 1 ? "is 1 ENABLED conversion action" : `are ${enabled.length} ENABLED conversion actions`} but ZERO conversions were recorded in the last ${date_range.replace("LAST_", "").replace("_DAYS", "").toLowerCase()} days — the Google tag / gtag / GA4 import may not be firing. Verify the tag is installed + firing (Google Ads → Conversions → diagnostics) before trusting Google ROAS.`;
    } else {
      overall_status = "healthy";
      suggestion =
        "Conversion tracking looks healthy — ENABLED conversion actions are recording conversions in the window. Optionally confirm Enhanced Conversions is on for stronger match rates.";
    }

    const { usage_by_action, bidding_campaigns_by_action, bidding_map_complete, ...campaignGoals } = await readConversionGoals(ctx.tenant_id, actions, inventoryComplete && unobservedMetricActions.length === 0, search, campaign_id);
    const bidding_tracking = campaign_id
      ? null
      : await readBiddingTracking(search, actions, bidding_campaigns_by_action, bidding_map_complete && unobservedMetricActions.length === 0);
    if (bidding_tracking?.note && (bidding_tracking.verdict === "broken" || bidding_tracking.verdict === "warming_up")) {
      suggestion = `${bidding_tracking.note} ${suggestion}`;
    }
    for (const action of actions) {
      action.used_by_campaigns = campaign_id || !action.resource_name ? null : usage_by_action.get(action.resource_name) ?? null;
    }

    return {
      connected: true,
      inventory_complete: inventoryComplete,
      unobserved_metric_actions: unobservedMetricActions,
      unobserved_action_conversions_in_window: externallyRecorded,
      action_details_complete: inventoryComplete && unobservedMetricActions.length === 0,
      metrics_complete: metricsComplete,
      campaign_goals: campaignGoals,
      conversion_actions_found: actions.length,
      enabled_actions: enabled.length,
      recent_conversions_in_window: recentConversions,
      tracking_verdict: bidding_tracking ? trackingVerdictOf(bidding_tracking) : null,
      overall_status,
      suggestion,
      bidding_tracking,
      date_range,
      conversion_actions: actions,
      limitation:
        "Manager-owned action metrics can establish recording health without complete metadata; action_details_complete and campaign_goals report that separate limitation. Recent conversions counts All conversions once; Conversions is its subset. Action inventory and customer metrics are separate reads because v25 does not support metrics.conversions from conversion_action. A capped metrics read is incomplete, so missing rows cannot establish zero recording. Checks conversion-action status + recorded-conversion recency (the programmatic proxies). Does not inspect live gtag/GTM firing or the Enhanced Conversions toggle directly — a 'stale' status is the proxy for 'the tag may not be firing'.",
    };
  },
};
