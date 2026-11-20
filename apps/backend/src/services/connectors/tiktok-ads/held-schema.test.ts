import { describe, expect, it } from "vitest";
import { aboveFloor, isTiktokSpendWrite, TIKTOK_CREATE_LAUNCH_CLASS, TIKTOK_HELD_CLASSES, tiktokActionRaisesSpend, tiktokBudgetBody, tiktokStatusBody } from "./held-schema";
import { editFields, reviseAdPayload } from "@/services/channels/ad-review/adapters";
import { adReviewVersion } from "@/services/channels/ad-review/version";
import { recommendation } from "@/services/channels/ad-review/recommendation";
import { projectAdReview } from "@/services/channels/ad-review-presentation";

describe("pending ad review revisions", () => {
  const proposal = {
    advertiser_id: "123456", advertiser_name: "Brand", campaign_type: "TRAFFIC", name: "Launch",
    locations: [{ location_id: "6252001", country_code: "US", name: "United States" }],
    daily_budget_usd: 25, start_time: "2026-11-01T12:00:00Z",
    video: { video_id: "video_123", source: "zavi", width: 720, height: 1280, duration_s: 12 },
    identity: { identity_id: "brand123", identity_type: "TT_USER", display_name: "Brand" },
    ad_text: "See how it works", call_to_action: "LEARN_MORE", landing_url: "https://example.com",
    hold_estimate_usd: null, rationale: "Launch traffic",
  };
  it("revises permitted copy and UTC dates without changing account, media or budget", () => {
    const next = reviseAdPayload(TIKTOK_CREATE_LAUNCH_CLASS, proposal, { ad_text: "Explore our new launch", start_time: "2026-11-03" });
    expect(next).toEqual({ ...proposal, ad_text: "Explore our new launch", start_time: "2026-11-03T00:00:00Z" });
    expect(proposal.ad_text).toBe("See how it works");
    expect(editFields(TIKTOK_CREATE_LAUNCH_CLASS, proposal).some((field) => field.key === "end_time")).toBe(false);
  });
  it.each(["advertiser_id", "daily_budget_usd", "video.video_id", "end_time", "__proto__"]) ("refuses an undeclared edit to %s", (key) => {
    expect(() => reviseAdPayload(TIKTOK_CREATE_LAUNCH_CLASS, proposal, { [key]: "123" })).toThrow();
  });
  it("retains provider limits and rejects invalid dates and unsafe URLs", () => {
    expect(() => reviseAdPayload(TIKTOK_CREATE_LAUNCH_CLASS, proposal, { ad_text: "a".repeat(101) })).toThrow();
    expect(() => reviseAdPayload(TIKTOK_CREATE_LAUNCH_CLASS, proposal, { start_time: "2026-02-30" })).toThrow();
    expect(() => reviseAdPayload(TIKTOK_CREATE_LAUNCH_CLASS, proposal, { landing_url: "javascript:alert(1)" })).toThrow();
  });
  it("versions the whole payload deterministically, including uneditable targeting", () => {
    const first = adReviewVersion(TIKTOK_CREATE_LAUNCH_CLASS, proposal);
    expect(first).toBe(adReviewVersion(TIKTOK_CREATE_LAUNCH_CLASS, Object.fromEntries(Object.entries(proposal).reverse())));
    expect(first).not.toBe(adReviewVersion(TIKTOK_CREATE_LAUNCH_CLASS, { ...proposal, daily_budget_usd: 30 }));
    expect(projectAdReview(TIKTOK_CREATE_LAUNCH_CLASS, proposal)?.revision).toBe(first);
  });
  it("previews the actual exclusive UTC end date used by the TikTok launch", () => {
    const payload = { ...proposal, end_date: "2026-11-10" };
    expect(projectAdReview(TIKTOK_CREATE_LAUNCH_CLASS, payload)?.schedule).toEqual({ start: "2026-11-01T12:00:00.000Z", end: "2026-11-10T00:00:00.000Z" });
    expect(projectAdReview(TIKTOK_CREATE_LAUNCH_CLASS, proposal)?.schedule?.end).toBeNull();
    expect(projectAdReview("meta_ads.create_ad", { end_date: "2026-11-10", end_time: "2026-11-11T23:59:59Z" })?.schedule?.end).toBe("2026-11-11T23:59:59.000Z");
  });
  it("never offers edits for an unsupported or invalid executor payload", () => {
    expect(editFields("linkedin_ads.create_campaign_bundle", {})).toEqual([]);
    expect(editFields(TIKTOK_CREATE_LAUNCH_CLASS, { ...proposal, daily_budget_usd: 1 })).toEqual([]);
  });
  it("requires real goal fit and impact before recommending an ad", () => {
    const row = { status: "pending", blocking: false, exec_status: null, score_inputs: { goal_fit: 1 }, impact: 4, score: 80 };
    expect(recommendation(row)?.reason).toContain("not measured ad performance");
    for (const override of [{ blocking: true }, { score_inputs: {} }, { impact: null }, { score: 60 }, { score_inputs: { goal_fit: 1, previously_rejected: true } }, { exec_status: "queued" }]) expect(recommendation({ ...row, ...override })).toBeNull();
  });
});

describe("isTiktokSpendWrite: one predicate for hiding and refusing raw TikTok spend writes", () => {
  it.each([
    "TIKTOK_ADS_UPDATE_CAMPAIGN_BUDGET",
    "TIKTOK_ADS_UPDATE_CAMPAIGN_STATUS",
    "TIKTOK_ADS_UPDATE_ADGROUP_BUDGET",
    "TIKTOK_ADS_UPDATE_AD_GROUP_STATUS",
    "TIKTOK_ADS_CREATE_CAMPAIGN",
    "TIKTOK_ADS_CREATE_SMART_PLUS_CAMPAIGN",
    "TIKTOK_ADS_CREATE_SMART_PLUS_AD",
    "TIKTOK_ADS_CREATE_SMART_PLUS_ADGROUP",
    "TIKTOK_ADS_CREATE_ADGROUP",
    "TIKTOK_ADS_CREATE_AD",
    "TIKTOK_ADS_UPDATE_ADS_STATUS",
    "TIKTOK_ADS_DELETE_CAMPAIGN",
    "tiktok_ads_update_campaign_budget",
  ])("%s is a spend write", (slug) => expect(isTiktokSpendWrite(slug)).toBe(true));

  it.each([
    "TIKTOK_ADS_GET_CREATIVE_ASSETS",
    "TIKTOK_ADS_GET_CAMPAIGNS",
    "TIKTOK_ADS_LIST_BUSINESS_CENTERS",
    "TIKTOK_ADS_GET_ADVERTISER_ACCOUNTS",
    "TIKTOK_ADS_DELETE_CREATIVE_ASSETS",
    "TIKTOK_ADS_UPLOAD_IMAGE",
    "TIKTOK_ADS_UPLOAD_VIDEO",
    "META_ADS_UPDATE_CAMPAIGN_BUDGET",
    "REDDIT_ADS_UPDATE_CAMPAIGN",
  ])("%s is not", (slug) => expect(isTiktokSpendWrite(slug)).toBe(false));

  it("GMV Max session writes (their own budget/schedule) are raw spend writes", () => {
    expect(isTiktokSpendWrite("TIKTOK_ADS_UPDATE_GMV_MAX_SESSION")).toBe(true);
  });
  it("a slug without the toolkit prefix counts once the catalog names tiktok_ads", () => {
    expect(isTiktokSpendWrite("UPDATE_CAMPAIGN_BUDGET")).toBe(false);
    expect(isTiktokSpendWrite("UPDATE_CAMPAIGN_BUDGET", "tiktok_ads")).toBe(true);
    expect(isTiktokSpendWrite("UPDATE_CAMPAIGN_BUDGET", "meta_ads")).toBe(false);
  });
});

describe("tiktokActionRaisesSpend (owner/admin boundary)", () => {
  it("a raise and a resume raise spend; a cut and a pause do not; unreadable fails closed", () => {
    expect(tiktokActionRaisesSpend("tiktok_ads.update_budget", { daily_budget_usd: 80, expected_current_daily_budget_usd: 60 })).toBe(true);
    expect(tiktokActionRaisesSpend("tiktok_ads.update_budget", { daily_budget_usd: 50, expected_current_daily_budget_usd: 60 })).toBe(false);
    expect(tiktokActionRaisesSpend("tiktok_ads.update_budget", {})).toBe(true);
    expect(tiktokActionRaisesSpend("tiktok_ads.set_status", { status: "ACTIVE" })).toBe(true);
    expect(tiktokActionRaisesSpend("tiktok_ads.set_status", { status: "PAUSED" })).toBe(false);
    expect(tiktokActionRaisesSpend("tiktok_ads.set_status", null)).toBe(true);
    expect(tiktokActionRaisesSpend("reddit_ads.update_budget", {})).toBe(false);
  });
});

describe("bodies", () => {
  const common = { advertiser_id: "111", advertiser_name: "Main", name: "Spring", rationale: "r" };
  it("an ad group names itself and its campaign; a campaign names only itself", () => {
    expect(tiktokBudgetBody.safeParse({ ...common, level: "ad_group", object_id: "9", campaign_id: "1", ad_group_id: "9", expected_current_daily_budget_usd: 30, expected_current_status: "ACTIVE", daily_budget_usd: 40 }).success).toBe(true);
    expect(tiktokBudgetBody.safeParse({ ...common, level: "ad_group", object_id: "9", campaign_id: "1", expected_current_daily_budget_usd: 30, expected_current_status: "ACTIVE", daily_budget_usd: 40 }).success).toBe(false);
    expect(tiktokBudgetBody.safeParse({ ...common, level: "campaign", object_id: "1", campaign_id: "2", expected_current_daily_budget_usd: 60, expected_current_status: "ACTIVE", daily_budget_usd: 70 }).success).toBe(false);
  });
  it("a budget below TikTok's floor, or no change, is refused", () => {
    expect(tiktokBudgetBody.safeParse({ ...common, level: "campaign", object_id: "1", campaign_id: "1", expected_current_daily_budget_usd: 60, expected_current_status: "ACTIVE", daily_budget_usd: 40 }).success).toBe(false);
    expect(tiktokBudgetBody.safeParse({ ...common, level: "campaign", object_id: "1", campaign_id: "1", expected_current_daily_budget_usd: 60, expected_current_status: "ACTIVE", daily_budget_usd: 60 }).success).toBe(false);
  });
  it("a resume needs the daily budget it will be held at; a pause does not", () => {
    const s = { ...common, level: "campaign", object_id: "1", campaign_id: "1" };
    expect(tiktokStatusBody.safeParse({ ...s, status: "ACTIVE", expected_current_status: "PAUSED", daily_budget_usd: null }).success).toBe(false);
    expect(tiktokStatusBody.safeParse({ ...s, status: "PAUSED", expected_current_status: "ACTIVE", daily_budget_usd: null }).success).toBe(true);
    expect(tiktokStatusBody.safeParse({ ...s, status: "PAUSED", expected_current_status: "PAUSED", daily_budget_usd: null }).success).toBe(false);
  });
});

describe("TikTok's daily-budget floors are strict: the budget must EXCEED them", () => {
  const common = { advertiser_id: "111", advertiser_name: "Main", name: "Spring", rationale: "r", expected_current_status: "ACTIVE" };
  const group = (to: number) => tiktokBudgetBody.safeParse({ ...common, level: "ad_group", object_id: "9", campaign_id: "1", ad_group_id: "9", expected_current_daily_budget_usd: 30, daily_budget_usd: to }).success;
  const campaign = (to: number) => tiktokBudgetBody.safeParse({ ...common, level: "campaign", object_id: "1", campaign_id: "1", expected_current_daily_budget_usd: 60, daily_budget_usd: to }).success;
  it("ad group: $20.00 refused, $20.01 passes", () => {
    expect(group(20)).toBe(false);
    expect(group(20.01)).toBe(true);
    expect(aboveFloor(20, "ad_group")).toBe(false);
    expect(aboveFloor(20.01, "ad_group")).toBe(true);
  });
  it("campaign: $50.00 refused, $50.01 passes", () => {
    expect(campaign(50)).toBe(false);
    expect(campaign(50.01)).toBe(true);
    expect(aboveFloor(50, "campaign")).toBe(false);
    expect(aboveFloor(50.01, "campaign")).toBe(true);
  });
});

describe("the launch class", () => {
  it("always raises spend (owner/admin), and is not one Autopilot may route", () => {
    expect(tiktokActionRaisesSpend(TIKTOK_CREATE_LAUNCH_CLASS, {})).toBe(true);
    expect(tiktokActionRaisesSpend(TIKTOK_CREATE_LAUNCH_CLASS, null)).toBe(true);
    expect(TIKTOK_HELD_CLASSES.has(TIKTOK_CREATE_LAUNCH_CLASS)).toBe(false);
  });
});
