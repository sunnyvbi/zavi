
import { describe, expect, it, vi } from "vitest";
import {
  campaignBudgetAtStake,
  readCardMoneyAtStake,
  readExclusiveCampaignDailyBudgetUsd,
} from "../_stake-budget";

const CAMPAIGN = "123";
const BUDGET_RESOURCE = "customers/1/campaignBudgets/9";

const pause = (over: Record<string, unknown> = {}) => ({
  campaign_id: CAMPAIGN,
  level: "campaign",
  status: "PAUSED",
  rationale: "0 conversions in 30 days",
  over_cap: false,
  ...over,
});

const live = (dailyUsd: number) => ({
  campaign_resource: `customers/1/campaigns/${CAMPAIGN}`,
  campaign_status: "ENABLED",
  budget_resource: BUDGET_RESOURCE,
  amount_micros: Math.round(dailyUsd * 1_000_000),
});

const sharedWith = (ids: string[]) =>
  vi.fn(async () => [
    { campaign: { id: "999", campaignBudget: "customers/1/campaignBudgets/other" } },
    ...ids.map((id) => ({ campaign: { id, campaignBudget: BUDGET_RESOURCE } })),
  ]);

describe("campaignBudgetAtStake — what an Approve actually stops", () => {
  it("prices a campaign-level pause and enable: the same dollars either way", () => {
    expect(campaignBudgetAtStake("google_ads.set_status", pause())).toEqual({ campaign_id: CAMPAIGN });
    expect(campaignBudgetAtStake("google_ads.set_status_review", pause())).toEqual({ campaign_id: CAMPAIGN });
    expect(campaignBudgetAtStake("google_ads.set_status", pause({ status: "ENABLED" }))).toEqual({
      campaign_id: CAMPAIGN,
    });
    expect(campaignBudgetAtStake("google_ads.set_status", { campaign_id: CAMPAIGN })).toEqual({
      campaign_id: CAMPAIGN,
    });
  });

  it("refuses anything narrower than a campaign", () => {
    expect(campaignBudgetAtStake("google_ads.set_status", pause({ level: "ad_group", ad_group_id: "7" }))).toBeNull();
    expect(campaignBudgetAtStake("google_ads.set_status", pause({ level: "ad", ad_group_id: "7", ad_id: "8" }))).toBeNull();
  });

  it("prices a campaign removal, and nothing smaller", () => {
    expect(campaignBudgetAtStake("google_ads.remove_resource", { level: "campaign", campaign_id: CAMPAIGN })).toEqual({
      campaign_id: CAMPAIGN,
    });
    expect(campaignBudgetAtStake("google_ads.remove_resource", { level: "ad_group", ad_group_id: "7" })).toBeNull();
    expect(
      campaignBudgetAtStake("google_ads.remove_resource", { level: "keyword", scope: "ad_group", parent_id: "7", criterion_id: "9" }),
    ).toBeNull();
  });

  it("refuses every class whose Approve does not move a whole campaign's budget", () => {
    for (const cls of [
      "google_ads.add_keywords",
      "google_ads.update_campaign",
      "google_ads.update_ad_group",
      "google_ads.create_campaign",
      "google_ads.create_ad_group",
      "google_ads.create_ad",
      "google_ads.update_campaign_budget",
    ]) {
      expect(campaignBudgetAtStake(cls, { campaign_id: CAMPAIGN, level: "campaign" }), cls).toBeNull();
    }
  });

  it("refuses a campaign id that is not one", () => {
    expect(campaignBudgetAtStake("google_ads.set_status", pause({ campaign_id: "all" }))).toBeNull();
    expect(campaignBudgetAtStake("google_ads.set_status", pause({ campaign_id: 123 }))).toBeNull();
    expect(campaignBudgetAtStake("google_ads.set_status", {})).toBeNull();
  });
});

describe("readExclusiveCampaignDailyBudgetUsd", () => {
  it("returns the live daily budget when this campaign is the only spender", async () => {
    const n = await readExclusiveCampaignDailyBudgetUsd("t-1", CAMPAIGN, {
      getBudget: vi.fn(async () => live(24.35)) as never,
      search: sharedWith([CAMPAIGN]),
    });
    expect(n).toBe(24.35);
  });

  it("returns null when the budget is SHARED — pausing one campaign stops nothing", async () => {
    const n = await readExclusiveCampaignDailyBudgetUsd("t-1", CAMPAIGN, {
      getBudget: vi.fn(async () => live(24.35)) as never,
      search: sharedWith([CAMPAIGN, "456"]),
    });
    expect(n).toBeNull();
  });

  it("returns null when the exclusivity read does not name this campaign at all", async () => {
    const n = await readExclusiveCampaignDailyBudgetUsd("t-1", CAMPAIGN, {
      getBudget: vi.fn(async () => live(24.35)) as never,
      search: sharedWith(["456"]),
    });
    expect(n).toBeNull();
  });

  it("returns null on a failed read, a missing budget or a zero amount", async () => {
    const search = sharedWith([CAMPAIGN]);
    expect(
      await readExclusiveCampaignDailyBudgetUsd("t-1", CAMPAIGN, {
        getBudget: vi.fn(async () => {
          throw new Error("google_ads_not_connected");
        }) as never,
        search,
      }),
    ).toBeNull();
    expect(
      await readExclusiveCampaignDailyBudgetUsd("t-1", CAMPAIGN, {
        getBudget: vi.fn(async () => live(24.35)) as never,
        search: vi.fn(async () => {
          throw new Error("boom");
        }),
      }),
    ).toBeNull();
    expect(
      await readExclusiveCampaignDailyBudgetUsd("t-1", CAMPAIGN, {
        getBudget: vi.fn(async () => live(0)) as never,
        search,
      }),
    ).toBeNull();
    expect(
      await readExclusiveCampaignDailyBudgetUsd("t-1", CAMPAIGN, {
        getBudget: vi.fn(async () => ({ ...live(10), budget_resource: "" })) as never,
        search,
      }),
    ).toBeNull();
  });
});

describe("readCardMoneyAtStake — the block attached to the card", () => {
  const deps = { getBudget: vi.fn(async () => live(24.35)) as never, search: sharedWith([CAMPAIGN]) };

  it("names the campaign and the source, so a stale number cannot be reused", async () => {
    expect(await readCardMoneyAtStake("t-1", "google_ads.set_status", pause(), deps)).toEqual({
      daily_budget_usd: 24.35,
      scope: "campaign",
      campaign_id: CAMPAIGN,
      source: "google_ads.campaign_budget",
    });
  });

  it("spends no read at all on a change that could not use the answer", async () => {
    const getBudget = vi.fn();
    expect(
      await readCardMoneyAtStake("t-1", "google_ads.set_status", pause({ level: "ad_group", ad_group_id: "7" }), {
        getBudget: getBudget as never,
      }),
    ).toBeNull();
    expect(getBudget).not.toHaveBeenCalled();
  });

  it("is null when the budget cannot be proven exclusive", async () => {
    expect(
      await readCardMoneyAtStake("t-1", "google_ads.set_status", pause(), {
        getBudget: vi.fn(async () => live(24.35)) as never,
        search: sharedWith([CAMPAIGN, "456"]),
      }),
    ).toBeNull();
  });
});
