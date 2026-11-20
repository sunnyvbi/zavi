import { gadsSearch, type GoogleAdsSearch } from "./_client";

const LIMIT = 10_000;
const MAX_CAMPAIGN_OUTPUT_BYTES = 60_000;
type GoalRow = { campaign?: { name?: string; status?: string }; campaignConversionGoal?: { campaign?: string; category?: string; origin?: string; biddable?: boolean } };
type ConfigRow = { campaign?: { name?: string; status?: string }; conversionGoalCampaignConfig?: { campaign?: string; goalConfigLevel?: string; customConversionGoal?: string }; customConversionGoal?: { resourceName?: string; status?: string; conversionActions?: string[] } };
export type CampaignRef = { campaign_id: string | null; name: string | null; status: string | null };
export type GoalAction = { resource_name: string | null; status: string | null; category: string | null; origin: string | null; primary_for_goal: boolean | null };

export async function readConversionGoals(tenantId: string, actions: GoalAction[], actionsComplete: boolean, search: GoogleAdsSearch = (query) => gadsSearch(tenantId, query), campaignId?: string) {
  if (campaignId !== undefined && !/^\d+$/.test(campaignId)) throw new Error("Invalid campaign ID");
  const filter = `campaign.status != 'REMOVED'${campaignId ? ` AND campaign.id = ${campaignId}` : ""}`;
  const reads = await Promise.allSettled([
    search(`SELECT campaign.name, campaign.status, campaign_conversion_goal.campaign, campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable FROM campaign_conversion_goal WHERE ${filter} LIMIT ${LIMIT}`),
    search(`SELECT campaign.name, campaign.status, conversion_goal_campaign_config.campaign, conversion_goal_campaign_config.goal_config_level, conversion_goal_campaign_config.custom_conversion_goal, custom_conversion_goal.resource_name, custom_conversion_goal.status, custom_conversion_goal.conversion_actions FROM conversion_goal_campaign_config WHERE ${filter} LIMIT ${LIMIT}`),
  ]);
  const goals = reads[0].status === "fulfilled" ? (reads[0].value as GoalRow[]).filter((row) => row.campaign?.status !== "REMOVED") : [];
  const configs = reads[1].status === "fulfilled" ? (reads[1].value as ConfigRow[]).filter((row) => row.campaign?.status !== "REMOVED") : [];
  const complete = reads.every((result) => result.status === "fulfilled" && result.value.length < LIMIT);
  const resources = [...new Set([...goals.map((row) => row.campaignConversionGoal?.campaign), ...configs.map((row) => row.conversionGoalCampaignConfig?.campaign)].filter((value): value is string => Boolean(value)))].sort();
  const refs = new Map<string, CampaignRef>();
  for (const row of [...goals.map((g) => ({ resource: g.campaignConversionGoal?.campaign, campaign: g.campaign })), ...configs.map((c) => ({ resource: c.conversionGoalCampaignConfig?.campaign, campaign: c.campaign }))]) {
    if (row.resource && !refs.has(row.resource)) refs.set(row.resource, { campaign_id: row.resource.split("/").at(-1) ?? null, name: row.campaign?.name ?? null, status: row.campaign?.status ?? null });
  }
  const selects = new Map<string, Array<{ ref: CampaignRef; selected: boolean | null }>>();
  const bids = new Map<string, CampaignRef[]>();
  const campaigns = resources.map((resource) => {
    const row = configs.find((row) => row.conversionGoalCampaignConfig?.campaign === resource);
    const config = row?.conversionGoalCampaignConfig;
    const standard = goals.filter((row) => row.campaignConversionGoal?.campaign === resource).map((row) => ({
      category: row.campaignConversionGoal?.category ?? null,
      origin: row.campaignConversionGoal?.origin ?? null,
      biddable: row.campaignConversionGoal?.biddable ?? null,
    }));
    const customResource = config?.customConversionGoal || null;
    const custom = row?.customConversionGoal;
    const usesCustom = config?.goalConfigLevel === "CAMPAIGN" && customResource !== null;
    let resolved = complete && actionsComplete && ["CUSTOMER", "CAMPAIGN"].includes(config?.goalConfigLevel ?? "");
    if (usesCustom && (custom?.resourceName !== customResource || custom?.status !== "ENABLED" || !Array.isArray(custom?.conversionActions))) resolved = false;
    const effective = actions.map((action) => {
      let biddable: boolean | null = null;
      if (action.status === "REMOVED" || action.status === "HIDDEN") biddable = false;
      else if (action.status === "ENABLED" && resolved) {
        const standardBiddable = action.primary_for_goal === false ? false
          : action.primary_for_goal === true && action.category !== null && action.origin !== null
            ? standard.find((goal) => goal.category === action.category && goal.origin === action.origin)?.biddable ?? null : null;
        const customBiddable = !usesCustom ? false : action.resource_name === null ? null : (custom?.conversionActions ?? []).includes(action.resource_name);
        biddable = standardBiddable === true || customBiddable === true ? true
          : standardBiddable === false && customBiddable === false ? false : null;
      }
      let selected: boolean | null = false;
      if (action.status === "ENABLED" || action.status === null) {
        const baseResolved = complete && actionsComplete && ["CUSTOMER", "CAMPAIGN"].includes(config?.goalConfigLevel ?? "")
          && !(usesCustom && (custom?.resourceName !== customResource || custom?.status !== "ENABLED" || !Array.isArray(custom?.conversionActions)));
        if (!baseResolved || action.status === null) selected = null;
        else {
          const standardSelects = action.category !== null && action.origin !== null
            ? standard.find((goal) => goal.category === action.category && goal.origin === action.origin)?.biddable ?? null : null;
          const customSelects = !usesCustom ? false : action.resource_name === null ? null : (custom?.conversionActions ?? []).includes(action.resource_name);
          selected = standardSelects === true || customSelects === true ? true : standardSelects === false && customSelects === false ? false : null;
        }
      }
      if (action.resource_name) {
        const list = selects.get(action.resource_name) ?? [];
        list.push({ ref: refs.get(resource) ?? { campaign_id: resource.split("/").at(-1) ?? null, name: null, status: null }, selected });
        selects.set(action.resource_name, list);
      }
      if (biddable === true && action.resource_name && refs.get(resource)?.status === "ENABLED") {
        const list = bids.get(action.resource_name) ?? [];
        list.push(refs.get(resource) ?? { campaign_id: resource.split("/").at(-1) ?? null, name: null, status: null });
        bids.set(action.resource_name, list);
      }
      return { conversion_action: action.resource_name, biddable };
    });
    const unobservedCustomActions = usesCustom ? (custom?.conversionActions ?? []).filter((resource) => !actions.some((action) => action.resource_name === resource)) : [];
    if (effective.some((action) => action.biddable === null) || unobservedCustomActions.length > 0) resolved = false;
    return {
      campaign_id: resource.split("/").at(-1) ?? null, campaign_resource: resource,
      goal_config_level: config?.goalConfigLevel ?? null, standard_goals: standard,
      custom_goal: customResource ? { resource_name: customResource, status: custom?.status ?? null, conversion_actions: custom?.conversionActions ?? null, applies: usesCustom } : null,
      effective_actions: effective.filter((action) => action.biddable !== false), unobserved_custom_actions: unobservedCustomActions,
      effective_biddability_complete: resolved,
      has_biddable_action: effective.some((action) => action.biddable === true) ? true : resolved ? false : null,
    };
  });
  const usage_by_action = new Map<string, CampaignRef[] | null>();
  for (const action of actions) {
    if (!action.resource_name) continue;
    const entries = selects.get(action.resource_name) ?? [];
    usage_by_action.set(action.resource_name, !complete || entries.some((e) => e.selected === null) ? null : entries.filter((e) => e.selected).map((e) => e.ref));
  }
  let outputBytes = 0;
  const included = campaigns.filter((campaign) => {
    const bytes = Buffer.byteLength(JSON.stringify(campaign), "utf8");
    if (outputBytes + bytes > MAX_CAMPAIGN_OUTPUT_BYTES) return false;
    outputBytes += bytes;
    return true;
  });
  const outputTruncated = included.length < campaigns.length;
  return {
    usage_by_action,
    bidding_campaigns_by_action: bids,
    bidding_map_complete: complete && actionsComplete
      && campaigns.every((c) => {
        const status = refs.get(c.campaign_resource)?.status || null;
        return status === "ENABLED" ? c.effective_biddability_complete : status === "PAUSED";
      }),
    complete: complete && !outputTruncated, reads_complete: complete,
    campaigns: included, campaigns_total: campaigns.length, campaigns_omitted: campaigns.length - included.length,
    output_truncated: outputTruncated,
    reads: reads.map((result, index) => ({ resource: index === 0 ? "campaign_conversion_goal" : "conversion_goal_campaign_config", status: result.status === "rejected" ? "failed" : result.value.length >= LIMIT ? "possibly_truncated" : "complete" })),
    limitation: "Removed campaigns and known non-biddable action rows are omitted. Campaign detail output is bounded; when output_truncated, rerun conversion_tracking_health with campaign_id for the required campaign. Null means not observed. Custom membership can make secondary actions biddable. Cross-account actions absent from inventory prevent a no-biddable-action conclusion. No goal settings were changed.",
  };
}
