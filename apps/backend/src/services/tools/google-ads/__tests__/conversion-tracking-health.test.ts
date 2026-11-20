import { describe, it, expect, vi, beforeEach } from "vitest";

const gadsSearch = vi.fn();
vi.mock("../_client", () => ({
  gadsSearch: (...args: unknown[]) => gadsSearch(...args),
  createGoogleAdsReadSession: (tenant: string) => (query: string) => gadsSearch(tenant, query),
}));
import { conversionTrackingHealthTool } from "../conversion_tracking_health";
import { readConversionGoals } from "../_conversion-goals";
import { summarizeLag } from "../conversion_lag";

const actionResource = "customers/1/conversionActions/201";
const campaignResource = "customers/1/campaigns/101";
const ctx = { tenant_id: "tenant-one", log: vi.fn() };
const run = async () => await conversionTrackingHealthTool.execute(ctx, {}) as {
  overall_status: string; suggestion: string; enabled_actions: number; recent_conversions_in_window: number;
  conversion_actions: { counting_type: string | null; origin: string | null; primary_for_goal: boolean | null; conversions_in_window: number; all_conversions_in_window: number }[];
  campaign_goals: Awaited<ReturnType<typeof readConversionGoals>>;
};
const action = { resource_name: actionResource, status: "ENABLED", category: "PURCHASE", origin: "WEBSITE", primary_for_goal: false };
function mockAccount(status = "ENABLED", conversions = 42, allConversions = 50, primary = true) {
  gadsSearch.mockImplementation(async (_tenant: string, query: string) => {
    if (query.includes("FROM conversion_action")) return [{ conversionAction: { id: "201", resourceName: actionResource, name: "Purchase", status, primaryForGoal: primary, countingType: "MANY_PER_CLICK", origin: "WEBSITE", category: "PURCHASE" } }];
    if (query.includes("FROM customer ")) return [{ segments: { conversionAction: actionResource }, metrics: { conversions: String(conversions), allConversions: String(allConversions) } }];
    if (query.includes("FROM campaign_conversion_goal")) return [{ campaignConversionGoal: { campaign: campaignResource, category: "PURCHASE", origin: "WEBSITE", biddable: true } }];
    if (query.includes("FROM conversion_goal_campaign_config")) return [{ conversionGoalCampaignConfig: { campaign: campaignResource, goalConfigLevel: "CUSTOMER" } }];
    throw new Error("unexpected query");
  });
}

beforeEach(() => { gadsSearch.mockReset(); });
describe("conversion health and effective campaign goals", () => {
  it("distinguishes empty inventory from a failed read", async () => {
    gadsSearch.mockResolvedValue([]);
    expect((await run()).overall_status).toBe("no_conversion_actions");
    gadsSearch.mockRejectedValue(new Error("unavailable"));
    await expect(run()).rejects.toThrow("unavailable");
  });
  it("reports no enabled action and preserves the setup suggestion", async () => {
    mockAccount("REMOVED");
    expect(await run()).toMatchObject({ overall_status: "misconfigured", enabled_actions: 0 });
  });
  it("reports no observed recording without asserting a broken tag", async () => {
    mockAccount("ENABLED", 0, 0);
    expect(await run()).toMatchObject({ overall_status: "stale", suggestion: expect.stringMatching(/may not be firing/) });
  });
  it("uses supported separate inventory/metric queries and never double-counts conversions", async () => {
    mockAccount();
    const result = await run();
    expect(result).toMatchObject({ overall_status: "healthy", recent_conversions_in_window: 50, conversion_actions: [{ counting_type: "MANY_PER_CLICK", origin: "WEBSITE", conversions_in_window: 42, all_conversions_in_window: 50 }] });
    expect(result.campaign_goals.campaigns[0]).toMatchObject({ has_biddable_action: true, effective_biddability_complete: true });
    const queries: string[] = gadsSearch.mock.calls.map((call) => String(call[1]));
    expect(queries.find((query) => query.includes("FROM conversion_action"))).not.toMatch(/metrics\.|segments.date/);
    expect(queries.find((query) => query.includes("FROM customer "))).toContain("segments.conversion_action, metrics.conversions, metrics.all_conversions");
    expect(gadsSearch.mock.calls.every((call) => call[0] === ctx.tenant_id)).toBe(true);
  });
  it("confirms all-secondary non-biddability only with complete standard goal configuration", async () => {
    mockAccount("ENABLED", 0, 20, false);
    const result = await run();
    expect(result.campaign_goals.campaigns[0]).toMatchObject({ has_biddable_action: false, effective_biddability_complete: true });
  });
  it("preserves null booleans, counting type and origin", async () => {
    gadsSearch.mockImplementation(async (_tenant: string, query: string) => query.includes("FROM conversion_action") ? [{ conversionAction: { id: "201", resourceName: actionResource, status: "ENABLED" } }] : []);
    expect((await run()).conversion_actions[0]).toMatchObject({ counting_type: null, origin: null, primary_for_goal: null });
  });
  it("makes secondary actions biddable through an active custom goal", async () => {
    gadsSearch.mockResolvedValueOnce([]).mockResolvedValueOnce([{ conversionGoalCampaignConfig: { campaign: campaignResource, goalConfigLevel: "CAMPAIGN", customConversionGoal: "customers/1/customConversionGoals/301" }, customConversionGoal: { resourceName: "customers/1/customConversionGoals/301", status: "ENABLED", conversionActions: [actionResource] } }]);
    expect((await readConversionGoals("tenant-one", [action], true)).campaigns[0]).toMatchObject({ has_biddable_action: true, effective_biddability_complete: true });
  });
  it("ignores a stale custom reference on customer-level goals", async () => {
    gadsSearch.mockResolvedValueOnce([]).mockResolvedValueOnce([{ conversionGoalCampaignConfig: { campaign: campaignResource, goalConfigLevel: "CUSTOMER", customConversionGoal: "customers/1/customConversionGoals/301" }, customConversionGoal: { resourceName: "customers/1/customConversionGoals/301", status: "ENABLED", conversionActions: [actionResource] } }]);
    expect((await readConversionGoals("tenant-one", [action], true)).campaigns[0]).toMatchObject({ has_biddable_action: false, custom_goal: { applies: false } });
  });
  it("does not turn a partial goal read into a false negative or expose API error content", async () => {
    gadsSearch.mockRejectedValueOnce(new Error("secret user content")).mockResolvedValueOnce([{ conversionGoalCampaignConfig: { campaign: campaignResource, goalConfigLevel: "CUSTOMER" } }]);
    const result = await readConversionGoals("tenant-one", [action], true);
    expect(result).toMatchObject({ complete: false, campaigns: [{ has_biddable_action: null, effective_biddability_complete: false }] });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("keeps unknown custom members unresolved, including cross-account actions", async () => {
    gadsSearch.mockResolvedValueOnce([]).mockResolvedValueOnce([{ conversionGoalCampaignConfig: { campaign: campaignResource, goalConfigLevel: "CAMPAIGN", customConversionGoal: "customers/2/customConversionGoals/301" }, customConversionGoal: { resourceName: "customers/2/customConversionGoals/301", status: "ENABLED", conversionActions: ["customers/2/conversionActions/999"] } }]);
    expect((await readConversionGoals("tenant-one", [action], true)).campaigns[0]).toMatchObject({ has_biddable_action: null, effective_biddability_complete: false, unobserved_custom_actions: ["customers/2/conversionActions/999"] });
  });
  it("does not infer an absent standard goal or unknown primary flag is false", async () => {
    gadsSearch.mockResolvedValueOnce([]).mockResolvedValueOnce([{ conversionGoalCampaignConfig: { campaign: campaignResource, goalConfigLevel: "CUSTOMER" } }]);
    expect((await readConversionGoals("tenant-one", [{ ...action, primary_for_goal: true }], true)).campaigns[0].has_biddable_action).toBeNull();
  });
  it("marks row-limit and incomplete inventory cases unresolved", async () => {
    gadsSearch.mockResolvedValueOnce(Array.from({ length: 10000 }, () => ({ campaignConversionGoal: { campaign: campaignResource, category: "PURCHASE", origin: "WEBSITE", biddable: true } }))).mockResolvedValueOnce([{ conversionGoalCampaignConfig: { campaign: campaignResource, goalConfigLevel: "CUSTOMER" } }]);
    expect(await readConversionGoals("tenant-one", [action], false)).toMatchObject({ complete: false, reads_complete: false, reads: [{ status: "possibly_truncated" }, { status: "complete" }] });
    gadsSearch.mockResolvedValueOnce([]).mockResolvedValueOnce([{ conversionGoalCampaignConfig: { campaign: campaignResource, goalConfigLevel: "CUSTOMER" } }]);
    expect((await readConversionGoals("tenant-one", [action], false)).campaigns[0]).toMatchObject({ has_biddable_action: null, effective_biddability_complete: false });
  });
  it("keeps capped counts unknown while acknowledging observed recording", async () => {
    gadsSearch.mockResolvedValueOnce([{ conversionAction: { resourceName: actionResource, status: "ENABLED" } }])
      .mockResolvedValueOnce(Array.from({ length: 10000 }, () => ({ segments: { conversionAction: "customers/1/conversionActions/999" }, metrics: { conversions: "1", allConversions: "1" } })))
      .mockResolvedValue([]);
    expect(await run()).toMatchObject({ overall_status: "healthy", metrics_complete: false, recent_conversions_in_window: null, conversion_actions: [{ conversions_in_window: null, all_conversions_in_window: null }] });
  });
  it("does not call unknown status a disabled action", async () => {
    gadsSearch.mockResolvedValueOnce([{ conversionAction: { resourceName: actionResource } }]).mockResolvedValue([]);
    expect((await run()).overall_status).toBe("unknown");
  });

  it("does not treat missing custom membership as an observed empty list", async () => {
    gadsSearch.mockResolvedValueOnce([]).mockResolvedValueOnce([{ conversionGoalCampaignConfig: { campaign: campaignResource, goalConfigLevel: "CAMPAIGN", customConversionGoal: "customers/1/customConversionGoals/301" }, customConversionGoal: { resourceName: "customers/1/customConversionGoals/301", status: "ENABLED" } }]);
    expect((await readConversionGoals("tenant-one", [action], true)).campaigns[0]).toMatchObject({ has_biddable_action: null, effective_biddability_complete: false });
  });

  it("unions standard primary goals with custom membership instead of replacing them", async () => {
    gadsSearch.mockResolvedValueOnce([{ campaignConversionGoal: { campaign: campaignResource, category: "PURCHASE", origin: "WEBSITE", biddable: true } }])
      .mockResolvedValueOnce([{ conversionGoalCampaignConfig: { campaign: campaignResource, goalConfigLevel: "CAMPAIGN", customConversionGoal: "customers/1/customConversionGoals/301" }, customConversionGoal: { resourceName: "customers/1/customConversionGoals/301", status: "ENABLED", conversionActions: [] } }]);
    expect((await readConversionGoals("tenant-one", [{ ...action, primary_for_goal: true }], true)).campaigns[0]).toMatchObject({ has_biddable_action: true, effective_biddability_complete: true });
  });

});

describe("measurement review regressions", () => {
  it("filters removed campaigns in both queries and excludes resolved non-biddable actions", async () => {
    const removed = "customers/1/campaigns/999";
    gadsSearch.mockResolvedValueOnce([campaignResource, removed].map((campaign, index) => ({ campaign: { status: index ? "REMOVED" : "ENABLED" }, campaignConversionGoal: { campaign, category: "PURCHASE", origin: "WEBSITE", biddable: true } })))
      .mockResolvedValueOnce([campaignResource, removed].map((campaign, index) => ({ campaign: { status: index ? "REMOVED" : "ENABLED" }, conversionGoalCampaignConfig: { campaign, goalConfigLevel: "CUSTOMER" } })));
    const result = await readConversionGoals(ctx.tenant_id, [action, { ...action, resource_name: "primary", primary_for_goal: true }, { ...action, resource_name: "unresolved", primary_for_goal: null }], true);
    expect(result.campaigns).toHaveLength(1);
    expect(result.campaigns[0].effective_actions).toEqual([{ conversion_action: "primary", biddable: true }, { conversion_action: "unresolved", biddable: null }]);
    for (const [, query] of gadsSearch.mock.calls) expect(query).toContain("campaign.status != 'REMOVED'");
  });

  it("bounds goal output for 400 campaigns with 50 biddable actions and supports focused follow-up", async () => {
    const actions = Array.from({ length: 50 }, (_, i) => ({ ...action, resource_name: `customers/1/conversionActions/${i}`, primary_for_goal: true }));
    const campaigns = Array.from({ length: 400 }, (_, i) => `customers/1/campaigns/${i}`);
    gadsSearch.mockImplementation(async (_tenant: string, query: string) => {
      const scoped = query.includes("campaign.id = 399") ? campaigns.slice(-1) : campaigns;
      return query.includes("FROM campaign_conversion_goal")
        ? scoped.map((campaign) => ({ campaignConversionGoal: { campaign, category: "PURCHASE", origin: "WEBSITE", biddable: true } }))
        : scoped.map((campaign) => ({ conversionGoalCampaignConfig: { campaign, goalConfigLevel: "CUSTOMER" } }));
    });
    const result = await readConversionGoals(ctx.tenant_id, actions, true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64000);
    expect(result).toMatchObject({ complete: false, reads_complete: true, output_truncated: true, campaigns_total: 400 });
    expect(result.campaigns_omitted).toBe(400 - result.campaigns.length);
    expect(result.campaigns.every((campaign) => campaign.effective_actions.length === 50)).toBe(true);
    const focused = await readConversionGoals(ctx.tenant_id, actions, true, undefined, "399");
    expect(focused).toMatchObject({ complete: true, output_truncated: false, campaigns_total: 1, campaigns: [{ campaign_id: "399" }] });
    await expect(readConversionGoals(ctx.tenant_id, actions, true, undefined, "399 OR 1=1")).rejects.toThrow("Invalid campaign ID");
  });

  it("recognizes manager-owned conversion recording without claiming complete action metadata", async () => {
    gadsSearch.mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ segments: { conversionAction: "customers/2/conversionActions/99" }, metrics: { conversions: "7", allConversions: "10" } }])
      .mockResolvedValue([]);
    expect(await run()).toMatchObject({ overall_status: "healthy", action_details_complete: false, recent_conversions_in_window: 10, unobserved_action_conversions_in_window: 10 });
    gadsSearch.mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ segments: { conversionAction: "customers/2/conversionActions/99" }, metrics: { conversions: "0", allConversions: "0" } }])
      .mockResolvedValue([]);
    expect((await run()).overall_status).toBe("unknown");
  });

  it.each([0, 1, 4.99, 5, 100])("only tolerates unknown lag mass below five percent: %s", (unknown) => {
    const summary = summarizeLag([
      { segments: { conversionLagBucket: "ONE_TO_TWO_DAYS" }, metrics: { conversions: 100 - unknown } },
      { segments: { conversionLagBucket: "UNKNOWN" }, metrics: { conversions: unknown } },
    ]);
    expect(summary).toMatchObject({ observed_conversions: 100, unknown_bucket_share: unknown / 100, l90_days: unknown < 5 ? 2 : null, estimated_from_known_buckets: unknown > 0 && unknown < 5 });
  });
});

describe("used_by_campaigns", () => {
  const signup = "customers/1/conversionActions/301";
  function mockSignupAccount(opts: { goalBiddable?: boolean; goalReadFails?: boolean; campaigns?: number } = {}) {
    const campaigns = Array.from({ length: opts.campaigns ?? 1 }, (_, i) => `customers/1/campaigns/${101 + i}`);
    gadsSearch.mockImplementation(async (_tenant: string, query: string) => {
      if (query.includes("FROM conversion_action")) return [{ conversionAction: { id: "301", resourceName: signup, name: "Signup", status: "ENABLED", primaryForGoal: false, includeInConversionsMetric: false, origin: "WEBSITE", category: "SIGNUP" } }];
      if (query.includes("FROM customer ")) return [{ segments: { conversionAction: signup }, metrics: { conversions: "0", allConversions: "8" } }];
      if (query.includes("FROM campaign_conversion_goal")) {
        if (opts.goalReadFails) throw new Error("unavailable");
        return campaigns.map((campaign, i) => ({ campaign: { name: `Campaign ${i}`, status: "ENABLED" }, campaignConversionGoal: { campaign, category: "SIGNUP", origin: "WEBSITE", biddable: opts.goalBiddable ?? true } }));
      }
      if (query.includes("FROM conversion_goal_campaign_config")) return campaigns.map((campaign, i) => ({ campaign: { name: `Campaign ${i}`, status: "ENABLED" }, conversionGoalCampaignConfig: { campaign, goalConfigLevel: "CUSTOMER" } }));
      throw new Error("unexpected query");
    });
  }
  type Out = { conversion_actions: Array<{ in_conversions_column: boolean | null; used_by_campaigns: Array<{ campaign_id: string; name: string; status: string }> | null }>; campaign_goals: Record<string, unknown> };

  it("names the campaigns whose goals select an action even while it is excluded from Conversions", async () => {
    mockSignupAccount();
    const out = (await run()) as unknown as Out;
    expect(out.conversion_actions[0]).toMatchObject({ in_conversions_column: false, used_by_campaigns: [{ campaign_id: "101", name: "Campaign 0", status: "ENABLED" }] });
    const queries: string[] = gadsSearch.mock.calls.map((call) => String(call[1]));
    expect(queries.find((q) => q.includes("FROM conversion_action"))).toContain("conversion_action.include_in_conversions_metric");
    expect(queries.find((q) => q.includes("FROM campaign_conversion_goal"))).toContain("campaign.name");
    expect(queries.find((q) => q.includes("FROM conversion_goal_campaign_config"))).toContain("campaign.name");
    expect("usage_by_action" in out.campaign_goals).toBe(false);
  });

  it("is empty when every campaign resolved and none selects the action", async () => {
    mockSignupAccount({ goalBiddable: false });
    expect(((await run()) as unknown as Out).conversion_actions[0].used_by_campaigns).toEqual([]);
  });

  it("is null, never empty, when a campaign's goals could not be read", async () => {
    mockSignupAccount({ goalReadFails: true });
    expect(((await run()) as unknown as Out).conversion_actions[0].used_by_campaigns).toBeNull();
  });

  it("counts campaigns cut from the bounded goal output", async () => {
    mockSignupAccount({ campaigns: 2000 });
    const out = (await run()) as unknown as Out & { campaign_goals: { output_truncated: boolean } };
    expect(out.campaign_goals.output_truncated).toBe(true);
    expect(out.conversion_actions[0].used_by_campaigns).toHaveLength(2000);
  });

  it("stays null when scoped to one campaign, which cannot speak for the account", async () => {
    mockSignupAccount();
    const out = (await conversionTrackingHealthTool.execute(ctx, { campaign_id: "101" })) as unknown as Out;
    expect(out.conversion_actions[0].used_by_campaigns).toBeNull();
  });
});
