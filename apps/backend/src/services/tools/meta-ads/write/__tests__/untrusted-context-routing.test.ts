import { describe, it, expect } from "vitest";
import { pickDecisionClass } from "@/services/tools/meta-ads/write/_class-router";

describe("tainted runs cannot auto-apply a spend change", () => {
  it("PAUSE with caps enabled auto-applies when untainted", () => {
    expect(
      pickDecisionClass({ op: "status", status: "PAUSED", capEnabled: true }),
    ).toBe("meta_ads.set_status");
  });

  it("...but is forced to review when tainted", () => {
    expect(
      pickDecisionClass({
        op: "status",
        status: "PAUSED",
        capEnabled: true,
        forceApproval: true,
      }),
    ).toBe("meta_ads.set_status_review");
  });

  it("a within-cap budget change auto-applies when untainted", () => {
    expect(pickDecisionClass({ op: "budget", within: true })).toBe(
      "meta_ads.update_ad_set_budget",
    );
  });

  it("...but is forced to review when tainted", () => {
    expect(
      pickDecisionClass({ op: "budget", within: true, forceApproval: true }),
    ).toBe("meta_ads.update_ad_set_budget_review");
  });

  it("the override is one-directional: it never creates an auto-apply", () => {
    expect(
      pickDecisionClass({ op: "status", status: "ACTIVE", capEnabled: true, forceApproval: true }),
    ).toBe("meta_ads.set_status_review");
    expect(
      pickDecisionClass({ op: "budget", within: false, forceApproval: true }),
    ).toBe("meta_ads.update_ad_set_budget_review");
  });

  it("omitting forceApproval leaves routing byte-identical to before", () => {
    expect(pickDecisionClass({ op: "status", status: "ACTIVE", capEnabled: false })).toBe("meta_ads.set_status_review");
    expect(pickDecisionClass({ op: "status", status: "PAUSED", capEnabled: false })).toBe("meta_ads.set_status_review");
    expect(pickDecisionClass({ op: "budget", within: false })).toBe("meta_ads.update_ad_set_budget_review");
  });
});
