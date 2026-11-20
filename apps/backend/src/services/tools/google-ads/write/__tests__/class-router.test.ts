
import { describe, it, expect } from "vitest";
import { pickGoogleDecisionClass } from "../_class-router";

describe("pickGoogleDecisionClass — budget", () => {
  it("routes within-cap to the auto class", () => {
    expect(pickGoogleDecisionClass({ op: "budget", within: true })).toBe(
      "google_ads.update_campaign_budget",
    );
  });

  it("routes over-cap to the review class", () => {
    expect(pickGoogleDecisionClass({ op: "budget", within: false })).toBe(
      "google_ads.update_campaign_budget_review",
    );
  });

  it("step-guard forceApproval overrides within → review", () => {
    expect(
      pickGoogleDecisionClass({ op: "budget", within: true, forceApproval: true }),
    ).toBe("google_ads.update_campaign_budget_review");
  });

  it("forceApproval:false is byte-identical to plain within routing", () => {
    expect(
      pickGoogleDecisionClass({ op: "budget", within: true, forceApproval: false }),
    ).toBe("google_ads.update_campaign_budget");
  });
});

describe("pickGoogleDecisionClass — status", () => {
  it("PAUSE + cap enabled → auto", () => {
    expect(
      pickGoogleDecisionClass({ op: "status", status: "PAUSED", capEnabled: true }),
    ).toBe("google_ads.set_status");
  });

  it("PAUSE + cap NOT enabled → review (needs opt-in)", () => {
    expect(
      pickGoogleDecisionClass({ op: "status", status: "PAUSED", capEnabled: false }),
    ).toBe("google_ads.set_status_review");
  });

  it("ENABLED always reviews (resume re-opens spend), even with cap enabled", () => {
    expect(
      pickGoogleDecisionClass({ op: "status", status: "ENABLED", capEnabled: true }),
    ).toBe("google_ads.set_status_review");
  });
});

describe("Founder Rules: a rule-steered change never auto-applies on Google", () => {
  it("forceApproval routes an in-cap budget change and a capped pause to review", () => {
    expect(pickGoogleDecisionClass({ op: "budget", within: true, forceApproval: true })).toBe(
      "google_ads.update_campaign_budget_review",
    );
    expect(
      pickGoogleDecisionClass({ op: "status", status: "PAUSED", capEnabled: true, forceApproval: true }),
    ).toBe("google_ads.set_status_review");
    expect(pickGoogleDecisionClass({ op: "status", status: "PAUSED", capEnabled: true })).toBe(
      "google_ads.set_status",
    );
  });
});

describe("GOOGLE_ADS_DECISION_CLASSES", () => {
  it("maps every structural op to its own google_ads.* class", async () => {
    const { GOOGLE_ADS_DECISION_CLASSES } = await import("../_class-router");
    expect(GOOGLE_ADS_DECISION_CLASSES).toEqual({
      create_campaign: "google_ads.create_campaign",
      update_campaign: "google_ads.update_campaign",
      create_ad_group: "google_ads.create_ad_group",
      update_ad_group: "google_ads.update_ad_group",
      create_ad: "google_ads.create_ad",
      add_keywords: "google_ads.add_keywords",
      remove_resource: "google_ads.remove_resource",
    });
  });
});
