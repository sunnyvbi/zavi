import { describe, it, expect } from "vitest";
import { pickDecisionClass } from "../_class-router";
import { pickGoogleDecisionClass } from "../../../google-ads/write/_class-router";

const AUTO = {
  meta_budget: "meta_ads.update_ad_set_budget",
  meta_status: "meta_ads.set_status",
  google_budget: "google_ads.update_campaign_budget",
  google_status: "google_ads.set_status",
};
const REVIEW = {
  meta_budget: "meta_ads.update_ad_set_budget_review",
  meta_status: "meta_ads.set_status_review",
  google_budget: "google_ads.update_campaign_budget_review",
  google_status: "google_ads.set_status_review",
};

describe("ads autopilot coupled-v1 — budget routing by cap state", () => {
  it("within-$X budget → AUTO (meta + google)", () => {
    expect(pickDecisionClass({ op: "budget", within: true })).toBe(AUTO.meta_budget);
    expect(pickGoogleDecisionClass({ op: "budget", within: true })).toBe(AUTO.google_budget);
  });

  it("over-$X budget → REVIEW (meta + google)", () => {
    expect(pickDecisionClass({ op: "budget", within: false })).toBe(REVIEW.meta_budget);
    expect(pickGoogleDecisionClass({ op: "budget", within: false })).toBe(REVIEW.google_budget);
  });
});

describe("ads autopilot coupled-v1 — pause is coupled, resume always asks", () => {
  it("PAUSE + cap enabled → AUTO (pause is governed with budget by one enable)", () => {
    expect(pickDecisionClass({ op: "status", status: "PAUSED", capEnabled: true })).toBe(
      AUTO.meta_status,
    );
    expect(pickGoogleDecisionClass({ op: "status", status: "PAUSED", capEnabled: true })).toBe(
      AUTO.google_status,
    );
  });

  it("PAUSE + cap disabled → REVIEW (no opt-in → no auto)", () => {
    expect(pickDecisionClass({ op: "status", status: "PAUSED", capEnabled: false })).toBe(
      REVIEW.meta_status,
    );
    expect(pickGoogleDecisionClass({ op: "status", status: "PAUSED", capEnabled: false })).toBe(
      REVIEW.google_status,
    );
  });

  it("RESUME (ACTIVE/ENABLED) → REVIEW even with cap enabled (resume is NEVER coupled)", () => {
    expect(pickDecisionClass({ op: "status", status: "ACTIVE", capEnabled: true })).toBe(
      REVIEW.meta_status,
    );
    expect(pickGoogleDecisionClass({ op: "status", status: "ENABLED", capEnabled: true })).toBe(
      REVIEW.google_status,
    );
  });

  it("pause and resume route to DIFFERENT classes — so a never_auto clamp on the resume (_review) class never blocks pause", () => {
    const pauseMeta = pickDecisionClass({ op: "status", status: "PAUSED", capEnabled: true });
    const resumeMeta = pickDecisionClass({ op: "status", status: "ACTIVE", capEnabled: true });
    expect(pauseMeta).not.toBe(resumeMeta);
    expect(resumeMeta).toBe("meta_ads.set_status_review");
    expect(pauseMeta).toBe("meta_ads.set_status");

    const pauseG = pickGoogleDecisionClass({ op: "status", status: "PAUSED", capEnabled: true });
    const resumeG = pickGoogleDecisionClass({ op: "status", status: "ENABLED", capEnabled: true });
    expect(pauseG).not.toBe(resumeG);
    expect(resumeG).toBe("google_ads.set_status_review");
    expect(pauseG).toBe("google_ads.set_status");
  });
});
