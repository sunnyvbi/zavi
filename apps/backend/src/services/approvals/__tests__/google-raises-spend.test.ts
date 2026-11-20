import { describe, expect, it } from "vitest";
import { googleActionRaisesSpend } from "@zavi/shared";
import { approveNeedsOwnerOrAdmin } from "../approve-role-gate";

describe("googleActionRaisesSpend (fails closed per class)", () => {
  it.each([
    ["google_ads.update_campaign_budget", { daily_budget_usd: 30, expected_current_daily_budget_usd: 20 }, true],
    ["google_ads.update_campaign_budget_review", { daily_budget_usd: 10, expected_current_daily_budget_usd: 20 }, false],
    ["google_ads.update_campaign_budget_review", { daily_budget_usd: 20, expected_current_daily_budget_usd: 20 }, false],
    ["google_ads.update_campaign_budget", { daily_budget_usd: 10 }, true],
    ["google_ads.update_campaign_budget", { daily_budget_usd: "10", expected_current_daily_budget_usd: 20 }, true],
    ["google_ads.set_status", { status: "ENABLED" }, true],
    ["google_ads.set_status_review", { status: "PAUSED" }, false],
    ["google_ads.set_status", {}, true],
    ["google_ads.add_keywords", { negative: false, keywords: [] }, true],
    ["google_ads.add_keywords", { negative: true, keywords: [] }, false],
    ["google_ads.add_keywords", {}, true],
    ["google_ads.update_campaign", { new_name: "Renamed" }, false],
    ["google_ads.update_campaign", { target_cpa_usd: 5 }, true],
    ["google_ads.update_campaign", { target_roas: 2 }, true],
    ["google_ads.update_campaign", { network: { search_network: true } }, true],
    ["google_ads.update_campaign", { campaign_id: "1", new_name: "x", origin: "user_initiated_chat", founder_chat_order: true, verified_name: "Old" }, false],
    ["google_ads.update_ad_group", { ad_group_id: "1", new_name: "x", founder_chat_order: true, verified_name: "Old" }, false],
    ["google_ads.update_campaign", { founder_chat_order: true, verified_name: "Old" }, true],
    ["google_ads.update_campaign", { campaign_id: "1", founder_chat_order: true, target_cpa_usd: 5 }, true],
    ["google_ads.update_ad_group", { ad_group_id: "1", new_name: "x" }, false],
    ["google_ads.update_ad_group", { ad_group_id: "1" }, true],
    ["google_ads.update_campaign", { campaign_id: "1", new_name: "x", end_date: "2027-01-01" }, true],
    ["google_ads.update_ad_group", { cpc_bid_usd: 0.5 }, true],
    ["google_ads.create_campaign", {}, true],
    ["google_ads.create_ad_group", {}, true],
    ["google_ads.create_ad", {}, true],
    ["google_ads.remove_resource", { level: "campaign", campaign_id: "12" }, false],
    ["google_ads.remove_resource", { level: "ad_group", ad_group_id: "12" }, false],
    ["google_ads.remove_resource", { level: "ad", ad_group_id: "12", ad_id: "34" }, false],
    ["google_ads.remove_resource", { level: "campaign" }, true],
    ["google_ads.remove_resource", { level: "ad", ad_group_id: "12" }, true],
    ["google_ads.remove_resource", { level: "keyword", scope: "ad_group", parent_id: "1", criterion_id: "2", criterion_negative: true }, true],
    ["google_ads.remove_resource", { level: "keyword", scope: "ad_group", parent_id: "1", criterion_id: "2" }, true],
    ["google_ads.remove_resource", { level: "keyword", scope: "ad_group", parent_id: "1", criterion_id: "2", criterion_negative: false }, false],
    ["google_ads.remove_resource", { level: "keyword", criterion_negative: "false" }, true],
    ["google_ads.remove_resource", { level: "nope" }, true],
    ["google_ads.remove_resource", {}, true],
    ["google_ads.replace_geo_targets_review", {}, true],
    ["google_ads.something_new", {}, true],
    ["meta_ads.update_ad_set_budget", { daily_budget_usd: 999 }, false],
  ] as const)("%s %j -> %s", (cls, body, want) => {
    expect(googleActionRaisesSpend(cls, body)).toBe(want);
  });

  it("an unreadable body on a budget class is a raise", () => {
    expect(googleActionRaisesSpend("google_ads.update_campaign_budget", null)).toBe(true);
    expect(googleActionRaisesSpend(null, {})).toBe(false);
  });

  it("the shared approve gate reads it", () => {
    expect(approveNeedsOwnerOrAdmin("google_ads.update_campaign_budget_review", { daily_budget_usd: 30, expected_current_daily_budget_usd: 20 })).toBe(true);
    expect(approveNeedsOwnerOrAdmin("google_ads.update_campaign_budget_review", { daily_budget_usd: 10, expected_current_daily_budget_usd: 20 })).toBe(false);
  });
});
