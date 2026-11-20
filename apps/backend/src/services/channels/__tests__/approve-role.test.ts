import { describe, it, expect } from "vitest";
import { approveMoney, channelActionNeedsAdmin, channelActionRaisesSpend } from "../approve-role";

describe("channelActionNeedsAdmin", () => {
  it("a launch, a raise or a switch-on is owner/admin; a pause or a cut is any member's", () => {
    expect(channelActionNeedsAdmin("meta_ads.launch_campaign", {}, "meta_ads")).toBe(true);
    expect(channelActionNeedsAdmin("meta_ads.set_status_review", { status: "ACTIVE" }, "meta_ads")).toBe(true);
    expect(channelActionNeedsAdmin("meta_ads.set_status_review", { status: "PAUSED" }, "meta_ads")).toBe(false);
    expect(channelActionNeedsAdmin("linkedin_ads.create_campaign_bundle", {}, "linkedin_ads")).toBe(true);
  });
  it("a creator hire and a non-ChatGPT card on the ChatGPT channel are owner/admin", () => {
    expect(channelActionNeedsAdmin("creator.hire", {}, "ugc")).toBe(true);
    expect(channelActionNeedsAdmin("seo.create_pr.v1", {}, "chatgpt_ads")).toBe(true);
    expect(channelActionRaisesSpend("creator.hire", {})).toBe(false);
  });
  it("no exec class needs nothing", () => {
    expect(channelActionNeedsAdmin(null, {}, "meta_ads")).toBe(false);
  });
});

describe("approveMoney", () => {
  it("a create's own daily budget, a lifetime total, or nothing it cannot prove", () => {
    expect(approveMoney("meta_ads.create_ad_set", { daily_budget_usd: 25 }, {})).toEqual({ daily_usd: 25, monthly_usd: 760 });
    expect(approveMoney("linkedin_ads.launch_campaign", { total_budget_usd: 900 }, {})).toEqual({ total_usd: 900 });
    expect(approveMoney("meta_ads.create_ad_set", { daily_budget_usd: 25, currency: "INR" }, {})).toBeNull();
    expect(approveMoney("meta_ads.set_status_review", { status: "PAUSED" }, {})).toBeNull();
  });
});
