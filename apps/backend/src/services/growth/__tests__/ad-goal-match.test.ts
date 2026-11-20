
import { describe, it, expect } from "vitest";
import {
  adGoalModeOf,
  adGoalModeOfTier,
  brandCampaignIds,
  brandTokens,
  keywordIsBrand,
  metaResultsMatchGoal,
  googleResultsMatchGoal,
  withGoalMatch,
} from "../ad-goal-match";
import { PAID_LABELS, paidLabel } from "../cgo-evidence";
import type { AdObjectFacts } from "../unattended-policy";

describe("adGoalModeOf: what a result is for each goal", () => {
  it.each([
    ["gmv", "value"],
    ["GMV", "value"],
    ["gross revenue", "value"],
    ["mrr", "value"],
    ["arr", "value"],
    ["revenue", "value"],
    ["booked value", "value"],
    ["bookings", "count"],
    ["booked_jobs", "count"],
    ["completed_bookings_per_week", "count"],
    ["orders", "count"],
    ["sales", "count"],
    ["paid_subscribers", "count"],
    ["new_paid_subscribers", "count"],
    ["new_customers", "count"],
    ["paid_first_sessions", "native"],
    ["rentals", "count"],
    ["signups", "native"],
    ["weekly signups", "native"],
    ["waitlist_signups", "native"],
    ["email_subscribers", "native"],
    ["hosts", "native"],
    ["repeat_booking_rate", "native"],
    ["first_paid_booking_rate", "native"],
    ["average order value", "native"],
    ["", "native"],
  ])("%s -> %s", (metric, mode) => {
    expect(adGoalModeOf(metric)).toBe(mode);
  });

  it("the top tier decides; mixed kinds or no goal keep the platform's results", () => {
    expect(adGoalModeOfTier(["gmv"])).toBe("value");
    expect(adGoalModeOfTier(["bookings", "orders"])).toBe("count");
    expect(adGoalModeOfTier(["bookings", "signups"])).toBe("native");
    expect(adGoalModeOfTier([])).toBe("native");
  });
});

describe("brand search detection", () => {
  it("tokens: the whole display name and the domain's own name, never short words", () => {
    expect(brandTokens("UpcarAI", "https://upcar.ai")).toEqual(["upcarai", "upcar"]);
    expect(brandTokens("Acme Cleaning Co", "www.acmecleaning.co.uk")).toEqual(["acmecleaningco", "acmecleaning"]);
    expect(brandTokens("Brightly", "app.brightly.io")).toEqual(["brightly"]);
    expect(brandTokens("Go", "go.com")).toEqual([]);
    expect(brandTokens(null, null)).toEqual([]);
    expect(brandTokens("", "not a url at all")).toEqual([]);
  });

  it("a keyword names the company with spaces and punctuation ignored; a generic word never does", () => {
    const t = brandTokens("UpcarAI", "upcar.ai");
    expect(keywordIsBrand("upcar", t)).toBe(true);
    expect(keywordIsBrand("up car rental", t)).toBe(true);
    expect(keywordIsBrand("upcar.ai", t)).toBe(true);
    expect(keywordIsBrand("car rental near me", t)).toBe(false);
    expect(keywordIsBrand("turo alternative", t)).toBe(false);
  });

  it("a campaign is brand only when MORE than half its enabled keywords name the company", () => {
    const t = ["acmecleaning"];
    const rows = [
      { campaign_id: "1", keyword: "acme cleaning" },
      { campaign_id: "1", keyword: "acmecleaning reviews" },
      { campaign_id: "1", keyword: "house cleaning" },
      { campaign_id: "2", keyword: "acme cleaning" },
      { campaign_id: "2", keyword: "maid service" },
      { campaign_id: "3", keyword: "deep cleaning near me" },
    ];
    expect([...brandCampaignIds(rows, t)]).toEqual(["1"]);
    expect(brandCampaignIds(rows, []).size).toBe(0);
  });
});

describe("do an object's results measure the goal?", () => {
  it("Meta: the optimisation event against a purchase goal; unknown is null (held), a non-purchase goal has no opinion", () => {
    expect(metaResultsMatchGoal("PURCHASE", "count")).toBe(true);
    expect(metaResultsMatchGoal("purchase", "value")).toBe(true);
    expect(metaResultsMatchGoal("COMPLETE_REGISTRATION", "value")).toBe(false);
    expect(metaResultsMatchGoal("LEAD", "count")).toBe(false);
    expect(metaResultsMatchGoal(null, "count")).toBeNull();
    expect(metaResultsMatchGoal("PURCHASE", "unknown")).toBeNull();
    expect(metaResultsMatchGoal("COMPLETE_REGISTRATION", "native")).toBeUndefined();
  });

  it("Google: per campaign, a campaign recording no purchase is counting something else (codex F4)", () => {
    const buying = new Set(["1"]);
    expect(googleResultsMatchGoal(buying, "1", "value")).toBe(true);
    expect(googleResultsMatchGoal(buying, "2", "value")).toBe(false);
    expect(googleResultsMatchGoal(null, "1", "count")).toBeNull();
    expect(googleResultsMatchGoal(buying, "1", "unknown")).toBeNull();
    expect(googleResultsMatchGoal(buying, "2", "native")).toBeUndefined();
  });

  it("withGoalMatch stamps the facts; the evidence label follows (brand first, then goal match)", () => {
    const base: AdObjectFacts = { id: "901", conversionObjective: true, objective: "SEARCH/MAXIMIZE_CONVERSIONS", learning: null, daysSinceEdit: null, lockDays: 0, spend7dUsd: 168, conversions7d: 0, targetCpaUsd: null, conversionEventFiring: true };
    const none = new Set<string>();
    const [brand] = withGoalMatch([base], "google", { mode: "value", googleBrand: new Set(["901"]), googlePurchaseCampaigns: none });
    expect(brand).toMatchObject({ brand: true, resultsMatchGoal: false });
    expect(paidLabel(brand!, "ok")).toBe(PAID_LABELS.brand);
    const [generic] = withGoalMatch([{ ...base, id: "902" }], "google", { mode: "value", googleBrand: new Set(["901"]), googlePurchaseCampaigns: none });
    expect(paidLabel(generic!, "ok")).toBe(PAID_LABELS.notGoal);
    const [brandUnread] = withGoalMatch([{ ...base, id: "903" }], "google", { mode: "native", googleBrand: null, googlePurchaseCampaigns: null });
    expect(brandUnread).toMatchObject({ brand: null });
    expect(brandUnread!.resultsMatchGoal).toBeUndefined();
    expect(paidLabel(brandUnread!, "ok")).toBe(PAID_LABELS.brandUnknown);
    const [goalUnread] = withGoalMatch([{ ...base, id: "904" }], "google", { mode: "count", googleBrand: none, googlePurchaseCampaigns: null });
    expect(goalUnread).toMatchObject({ brand: false, resultsMatchGoal: null });
    expect(paidLabel(goalUnread!, "ok")).toBe(PAID_LABELS.goalUnknown);
    const [native] = withGoalMatch([{ ...base, id: "905" }], "google", { mode: "native", googleBrand: none, googlePurchaseCampaigns: null });
    expect(paidLabel(native!, "ok")).toBe(PAID_LABELS.conversion);
    const [meta] = withGoalMatch([{ ...base, conversionEvent: "COMPLETE_REGISTRATION" }], "meta", { mode: "count", googleBrand: null, googlePurchaseCampaigns: null });
    expect(meta).toMatchObject({ brand: false, resultsMatchGoal: false });
  });
});
