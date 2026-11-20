import { describe, it, expect, vi, beforeEach } from "vitest";

const gadsSearch = vi.fn();
vi.mock("../_client", () => ({ gadsSearch: (...a: unknown[]) => gadsSearch(...a) }));

import { campaignDiagnosticsTool } from "../campaign_diagnostics";

const ctx = { tenant_id: "t-1" } as never;

type Campaign = {
  campaign_id: string;
  channel_type: string;
  networks: Record<string, boolean | null>;
  impression_share: null | Record<string, number | string | null>;
  geo_targeting: { positive_geo_target_type: string | null; note: string | null };
  asset_automation: unknown;
  bidding: { strategy_type: string | null; target_cpa: number | null };
  spend: number;
};

const isCurrencyQuery = (q: string) => q.includes("FROM customer");
const isAutoApplyQuery = (q: string) => q.includes("FROM recommendation_subscription");
const isServingQuery = (q: string) => q.includes("campaign.primary_status");
let serving: unknown[] | Error = [];
const isCampaignQuery = (q: string) => !isCurrencyQuery(q) && !isAutoApplyQuery(q) && !isServingQuery(q);

function mockCampaign(
  responses: Array<unknown[] | Error>,
  currency: string | null = "USD",
  autoApply: unknown[] | Error = [],
) {
  let i = 0;
  gadsSearch.mockImplementation(async (_t: string, query: string) => {
    if (isCurrencyQuery(query)) {
      return currency ? [{ customer: { currencyCode: currency } }] : [];
    }
    if (isAutoApplyQuery(query)) {
      if (autoApply instanceof Error) throw autoApply;
      return autoApply;
    }
    if (isServingQuery(query)) {
      if (serving instanceof Error) throw serving;
      return serving;
    }
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return r;
  });
}

beforeEach(() => {
  gadsSearch.mockReset().mockResolvedValue([]);
});

describe("google_ads_campaign_diagnostics — null is not zero", () => {
  it("carries a withheld impression share through as null, never 0", async () => {
    mockCampaign([
      [
        {
          campaign: { id: "1", name: "Search", advertisingChannelType: "SEARCH" },
          metrics: { costMicros: "1000000", conversions: "1" },
        },
      ],
    ]);
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as { campaigns: Campaign[] };
    const is = out.campaigns[0].impression_share!;
    expect(is.search).toBeNull();
    expect(is.lost_to_budget).toBeNull();
    expect(is.lost_to_rank).toBeNull();
    expect(is.search).not.toBe(0);
  });

  it("preserves a REAL zero impression share — 0 is a measurement, not an absence", async () => {
    mockCampaign([
      [
        {
          campaign: { id: "1", advertisingChannelType: "SEARCH" },
          metrics: {
            searchImpressionShare: 0,
            searchBudgetLostImpressionShare: 0.9,
            searchRankLostImpressionShare: 0.1,
          },
        },
      ],
    ]);
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as { campaigns: Campaign[] };
    const is = out.campaigns[0].impression_share!;
    expect(is.search).toBe(0);
    expect(is.lost_to_budget).toBe(0.9);
  });

  it("reports an absent network setting as null, so it is never read as 'off'", async () => {
    mockCampaign([
      [
        {
          campaign: {
            id: "1",
            advertisingChannelType: "SEARCH",
            networkSettings: { targetSearchNetwork: true },
          },
          metrics: {},
        },
      ],
    ]);
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as { campaigns: Campaign[] };
    expect(out.campaigns[0].networks.search_partners).toBe(true);
    expect(out.campaigns[0].networks.display_expansion).toBeNull();
    expect(out.campaigns[0].networks.display_expansion).not.toBe(false);
  });

  it("preserves a real false — an explicitly disabled network is not a null", async () => {
    mockCampaign([
      [
        {
          campaign: {
            id: "1",
            advertisingChannelType: "SEARCH",
            networkSettings: { targetContentNetwork: false },
          },
          metrics: {},
        },
      ],
    ]);
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as { campaigns: Campaign[] };
    expect(out.campaigns[0].networks.display_expansion).toBe(false);
  });

  it("omits impression share entirely on non-Search campaigns rather than reporting nulls as a finding", async () => {
    mockCampaign([
      [
        {
          campaign: { id: "9", advertisingChannelType: "PERFORMANCE_MAX" },
          metrics: { costMicros: "5000000" },
        },
      ],
    ]);
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as { campaigns: Campaign[] };
    expect(out.campaigns[0].impression_share).toBeNull();
  });
});

describe("google_ads_campaign_diagnostics — settings findings", () => {
  it("attaches the presence-or-interest explanation only when that mode is actually set", async () => {
    mockCampaign([
      [
        {
          campaign: {
            id: "1",
            advertisingChannelType: "SEARCH",
            geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE_OR_INTEREST" },
          },
          metrics: {},
        },
        {
          campaign: {
            id: "2",
            advertisingChannelType: "SEARCH",
            geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" },
          },
          metrics: {},
        },
      ],
    ]);
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as { campaigns: Campaign[] };
    expect(out.campaigns[0].geo_targeting.note).toContain("PRESENCE_OR_INTEREST");
    expect(out.campaigns[1].geo_targeting.note).toBeNull();
  });

  it("converts a target CPA from micros", async () => {
    mockCampaign([
      [
        {
          campaign: {
            id: "1",
            advertisingChannelType: "SEARCH",
            biddingStrategyType: "TARGET_CPA",
            targetCpa: { targetCpaMicros: "45000000" },
          },
          metrics: {},
        },
      ],
    ]);
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as { campaigns: Campaign[] };
    expect(out.campaigns[0].bidding.target_cpa).toBe(45);
    expect(out.campaigns[0].bidding.strategy_type).toBe("TARGET_CPA");
  });
});

describe("google_ads_campaign_diagnostics — currency is the account's, not USD", () => {
  it("names the account currency", async () => {
    mockCampaign([[{ campaign: { id: "1" }, metrics: { costMicros: "2000000" } }]], "GBP");
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as {
      currency_code: string | null;
      currency_note: string;
      campaigns: Campaign[];
    };
    expect(out.currency_code).toBe("GBP");
    expect(out.currency_note).toContain("GBP");
    expect(out.campaigns[0].spend).toBe(2);
  });

  it("warns rather than assuming USD when the currency cannot be read", async () => {
    mockCampaign([[{ campaign: { id: "1" }, metrics: {} }]], null);
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as {
      currency_code: string | null;
      currency_note: string;
    };
    expect(out.currency_code).toBeNull();
    expect(out.currency_note).toContain("do not write a dollar sign");
  });
});

describe("google_ads_campaign_diagnostics — degraded read", () => {
  it("retries without the newest field when Google rejects it, and says what it dropped", async () => {
    mockCampaign([
      new Error("Google Ads search failed: 400 UNRECOGNIZED_FIELD campaign.asset_automation_settings"),
      [{ campaign: { id: "1", advertisingChannelType: "SEARCH" }, metrics: {} }],
    ]);

    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as {
      campaigns: Campaign[];
      dropped_fields: string[];
      dropped_fields_note: string | null;
    };

    expect(out.dropped_fields).toEqual([
      "campaign.asset_automation_settings",
      "campaign.broad_match_migration_date_time",
      "campaign.aca_migration_date_time",
    ]);
    expect(out.campaigns[0].asset_automation).toBeNull();
    expect(out.dropped_fields_note).toContain("Do not report");
  });

  it("does NOT retry on a transient failure — a 500 must never be reported as a missing field", async () => {
    mockCampaign([new Error("Google Ads search failed: 500 INTERNAL_ERROR")]);
    await expect(campaignDiagnosticsTool.execute(ctx, {})).rejects.toThrow("500");

    const campaignCalls = gadsSearch.mock.calls.filter((c) =>
      isCampaignQuery((c as [string, string])[1]),
    );
    expect(campaignCalls).toHaveLength(1);
  });

  it("does NOT retry on an auth failure", async () => {
    mockCampaign([new Error("google_ads_token_revoked")]);
    await expect(campaignDiagnosticsTool.execute(ctx, {})).rejects.toThrow("google_ads_token_revoked");
  });

  it("does not select the newest field on the retry", async () => {
    mockCampaign([
      new Error("UNRECOGNIZED_FIELD"),
      [],
    ]);
    await campaignDiagnosticsTool.execute(ctx, {});
    const campaignQueries = gadsSearch.mock.calls
      .map((c) => (c as [string, string])[1])
      .filter(isCampaignQuery);
    const retry = campaignQueries[1];
    expect(retry).not.toContain("asset_automation_settings");
    expect(retry).toContain("metrics.search_budget_lost_impression_share");
  });

  it("propagates when even the reduced query cannot read", async () => {
    mockCampaign([
      new Error("UNRECOGNIZED_FIELD"),
      new Error("google_ads_not_connected"),
    ]);
    await expect(campaignDiagnosticsTool.execute(ctx, {})).rejects.toThrow(
      "google_ads_not_connected",
    );
  });
});

describe("google_ads_campaign_diagnostics — the shared-budget hole", () => {
  it("flags a shared budget and forbids a per-campaign utilisation read", async () => {
    mockCampaign([
      [
        {
          campaign: { id: "1", name: "Search A", advertisingChannelType: "SEARCH" },
          campaignBudget: {
            name: "Shared pool",
            amountMicros: "100000000",
            explicitlyShared: true,
            referenceCount: "2",
          },
          metrics: { costMicros: "50000000" },
        },
      ],
    ]);
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as {
      campaigns: Array<{
        budget: {
          explicitly_shared: boolean | null;
          campaigns_using_it: number | null;
          daily_amount: number | null;
          note: string | null;
        };
      }>;
    };
    const b = out.campaigns[0].budget;
    expect(b.explicitly_shared).toBe(true);
    expect(b.campaigns_using_it).toBe(2);
    expect(b.daily_amount).toBe(100);
    expect(b.note).toContain("POOL");
  });

  it("stays silent on a normal, unshared budget", async () => {
    mockCampaign([
      [
        {
          campaign: { id: "1", advertisingChannelType: "SEARCH" },
          campaignBudget: { amountMicros: "20000000", explicitlyShared: false, referenceCount: "1" },
          metrics: {},
        },
      ],
    ]);
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as {
      campaigns: Array<{ budget: { explicitly_shared: boolean | null; note: string | null } }>;
    };
    expect(out.campaigns[0].budget.explicitly_shared).toBe(false);
    expect(out.campaigns[0].budget.note).toBeNull();
  });

  it("hedges when sharing was not reported — null is not 'unshared'", async () => {
    mockCampaign([
      [
        {
          campaign: { id: "1", advertisingChannelType: "SEARCH" },
          campaignBudget: { amountMicros: "20000000" },
          metrics: {},
        },
      ],
    ]);
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as {
      campaigns: Array<{ budget: { explicitly_shared: boolean | null; note: string | null } }>;
    };
    expect(out.campaigns[0].budget.explicitly_shared).toBeNull();
    expect(out.campaigns[0].budget.note).toContain("live possibility");
  });

  it("selects the shared-budget field in the core query, not the droppable extras", async () => {
    mockCampaign([new Error("UNRECOGNIZED_FIELD"), []]);
    await campaignDiagnosticsTool.execute(ctx, {});
    const retry = gadsSearch.mock.calls
      .map((c) => (c as [string, string])[1])
      .filter(isCampaignQuery)[1];
    expect(retry).toContain("campaign_budget.explicitly_shared");
  });
});

describe("google_ads_campaign_diagnostics — auto-apply is a finding, not an instruction", () => {
  it("reports the recommendation types Google applies to the account unasked", async () => {
    mockCampaign([[{ campaign: { id: "1" }, metrics: {} }]], "USD", [
      { recommendationSubscription: { type: "KEYWORD", status: "ENABLED", createDateTime: "2026-01-02 10:00:00", modifyDateTime: "2026-08-01 09:00:00" } },
      { recommendationSubscription: { type: "CAMPAIGN_BUDGET", status: "PAUSED", createDateTime: "2026-02-03 11:00:00" } },
      { recommendationSubscription: { type: "SOME_NEW_TYPE", status: "ENABLED" } },
    ]);
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as {
      auto_apply: Array<Record<string, unknown>> | null;
      auto_apply_note: string;
    };
    expect(out.auto_apply).toEqual([
      { type: "KEYWORD", status: "ENABLED", name: "Add new keywords", changes: "adds keywords", since: "2026-08-01 09:00:00", scope: "account" },
      { type: "CAMPAIGN_BUDGET", status: "PAUSED", name: "Raise budgets", changes: "raises campaign daily budgets", since: "2026-02-03 11:00:00", scope: "account" },
      { type: "SOME_NEW_TYPE", status: "ENABLED", name: "Some new type", changes: null, since: null, scope: "account" },
    ]);
    expect(out.auto_apply_note).toContain("AUTO-APPLY");
    expect(out.auto_apply_note).toContain("account-wide");
    expect(out.auto_apply_note).toContain("GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION");
    const q = gadsSearch.mock.calls.map((c) => (c as [string, string])[1]).find(isAutoApplyQuery)!;
    expect(q).toContain("recommendation_subscription.create_date_time");
    expect(q).toContain("recommendation_subscription.modify_date_time");
  });

  it("says plainly when nothing is subscribed", async () => {
    mockCampaign([[{ campaign: { id: "1" }, metrics: {} }]], "USD", []);
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as { auto_apply_note: string };
    expect(out.auto_apply_note).toContain("not applying changes on its own");
  });

  it("distinguishes a FAILED read from 'auto-apply is off' — null, not empty", async () => {
    mockCampaign([[{ campaign: { id: "1" }, metrics: {} }]], "USD", new Error("permission denied"));
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as {
      auto_apply: unknown;
      auto_apply_note: string;
    };
    expect(out.auto_apply).toBeNull();
    expect(out.auto_apply_note).toContain("could not be read");
    expect(out.auto_apply_note).not.toContain("not applying changes on its own");
  });

  it("an auto-apply failure never takes the settings read down with it", async () => {
    mockCampaign(
      [[{ campaign: { id: "1", advertisingChannelType: "SEARCH" }, metrics: { costMicros: "5000000" } }]],
      "USD",
      new Error("boom"),
    );
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as {
      campaigns: Array<{ spend: number }>;
    };
    expect(out.campaigns[0].spend).toBe(5);
  });
});

describe("google_ads_campaign_diagnostics — AI Max, read not inferred", () => {
  it("reports AI Max ON for a Search campaign", async () => {
    mockCampaign([
      [
        {
          campaign: {
            id: "1",
            advertisingChannelType: "SEARCH",
            aiMaxSetting: { enableAiMax: true, bundlingRequired: "REQUIRED" },
          },
          metrics: {},
        },
      ],
    ]);
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as {
      campaigns: Array<{ ai_max: Record<string, unknown> }>;
    };
    expect(out.campaigns[0].ai_max.applicable).toBe(true);
    expect(out.campaigns[0].ai_max.enabled).toBe(true);
    expect(out.campaigns[0].ai_max.adopted_before).toBe("REQUIRED");
  });

  it("flags in-scope-but-not-migrated: campaign-level broad match on, AI Max off", async () => {
    mockCampaign([
      [
        {
          campaign: { id: "1", advertisingChannelType: "SEARCH", keywordMatchType: "BROAD" },
          metrics: {},
        },
      ],
    ]);
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as {
      campaigns: Array<{ ai_max: Record<string, unknown> }>;
    };
    const a = out.campaigns[0].ai_max;
    expect(a.enabled).toBe(false);
    expect(a.campaign_level_broad_match).toBe(true);
    expect(String(a.note)).toContain("In scope, not migrated");
  });

  it("says NOT APPLICABLE on a campaign type that has no AI Max setting — never 'off'", async () => {
    mockCampaign([
      [{ campaign: { id: "9", advertisingChannelType: "PERFORMANCE_MAX" }, metrics: {} }],
    ]);
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as {
      campaigns: Array<{ ai_max: Record<string, unknown> }>;
    };
    expect(out.campaigns[0].ai_max.applicable).toBe(false);
    expect(out.campaigns[0].ai_max.enabled).toBeNull();
    expect(String(out.campaigns[0].ai_max.note)).toContain("does not apply");
  });

  it("treats a cleared setting on an in-scope campaign as off", async () => {
    mockCampaign([[{ campaign: { id: "1", advertisingChannelType: "SHOPPING" }, metrics: {} }]]);
    const out = (await campaignDiagnosticsTool.execute(ctx, {})) as {
      campaigns: Array<{ ai_max: Record<string, unknown> }>;
    };
    expect(out.campaigns[0].ai_max.applicable).toBe(true);
    expect(out.campaigns[0].ai_max.enabled).toBe(false);
  });

  it("keeps the AI Max fields in the CORE query so an unrelated rejection cannot drop them", async () => {
    mockCampaign([new Error("UNRECOGNIZED_FIELD campaign.asset_automation_settings"), []]);
    await campaignDiagnosticsTool.execute(ctx, {});
    const retry = gadsSearch.mock.calls
      .map((c) => (c as [string, string])[1])
      .filter(isCampaignQuery)[1];
    expect(retry).toContain("campaign.ai_max_setting.enable_ai_max");
    expect(retry).toContain("campaign.keyword_match_type");
    expect(retry).not.toContain("asset_automation_settings");
    expect(retry).not.toContain("broad_match_migration_date_time");
  });
});

describe("not_serving: enabled campaigns that spent nothing, with Google's reason", () => {
  beforeEach(() => {
    serving = [];
  });

  it("a campaign with no impressions is absent from the settings rows but listed here, with its reason; one that spent is not", async () => {
    mockCampaign([[{ campaign: { id: "777", name: "Search", status: "ENABLED", advertisingChannelType: "SEARCH" }, metrics: { costMicros: "90000000" } }]]);
    serving = [
      { campaign: { id: "555", name: "Hosts $5", primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["MOST_ADS_UNDER_REVIEW"] } },
      { campaign: { id: "777", name: "Search", primaryStatus: "ELIGIBLE", primaryStatusReasons: [] } },
    ];
    const r = (await campaignDiagnosticsTool.execute(ctx, {})) as { not_serving: unknown[]; campaigns: unknown[] };
    expect(r.campaigns).toHaveLength(1);
    expect(r.not_serving).toEqual([
      { campaign_id: "555", campaign_name: "Hosts $5", primary_status: "NOT_ELIGIBLE", reasons: ["MOST_ADS_UNDER_REVIEW"], why: "its ads are still under review" },
    ]);
  });

  it("a failed status read leaves the rest whole and says so; a PAUSED-only read does not ask", async () => {
    mockCampaign([[]]);
    serving = new Error("Google Ads search failed: 500");
    const r = (await campaignDiagnosticsTool.execute(ctx, {})) as { not_serving: unknown; not_serving_note: string; campaigns: unknown[] };
    expect(r.not_serving).toBeNull();
    expect(r.not_serving_note).toContain("could not be read");
    gadsSearch.mockClear();
    await campaignDiagnosticsTool.execute(ctx, { status: "PAUSED" });
    expect(gadsSearch.mock.calls.some((c) => isServingQuery(String(c[1])))).toBe(false);
  });
});
