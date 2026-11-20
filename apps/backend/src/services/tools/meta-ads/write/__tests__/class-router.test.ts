
import { describe, it, expect } from "vitest";
import { pickDecisionClass } from "../_class-router";

describe("pickDecisionClass — budget", () => {
  it("routes within-cap to the auto class", () => {
    expect(pickDecisionClass({ op: "budget", within: true })).toBe(
      "meta_ads.update_ad_set_budget",
    );
  });

  it("routes over-cap to the review class", () => {
    expect(pickDecisionClass({ op: "budget", within: false })).toBe(
      "meta_ads.update_ad_set_budget_review",
    );
  });
});

describe("pickDecisionClass — user-initiated chat spend-apply (flag-gated)", () => {
  it("user_chat + flagOn + NOT unsure → auto class (executes directly)", () => {
    expect(
      pickDecisionClass({
        op: "budget",
        within: false,
        origin: "user_chat",
        flagOn: true,
        agentUnsure: false,
      }),
    ).toBe("meta_ads.update_ad_set_budget");
  });

  it("user_chat + flagOn + agentUnsure → review (ambiguity/misparse gate wins)", () => {
    expect(
      pickDecisionClass({
        op: "budget",
        within: true,
        origin: "user_chat",
        flagOn: true,
        agentUnsure: true,
      }),
    ).toBe("meta_ads.update_ad_set_budget_review");
  });

  it("user_chat + flag OFF → falls back to within-cap routing (byte-identical to today)", () => {
    expect(
      pickDecisionClass({
        op: "budget",
        within: true,
        origin: "user_chat",
        flagOn: false,
        agentUnsure: false,
      }),
    ).toBe("meta_ads.update_ad_set_budget");
    expect(
      pickDecisionClass({
        op: "budget",
        within: false,
        origin: "user_chat",
        flagOn: false,
        agentUnsure: false,
      }),
    ).toBe("meta_ads.update_ad_set_budget_review");
  });

  it("agent-initiated origin (flagOn) → within-cap routing UNCHANGED, never the fast-path", () => {
    expect(
      pickDecisionClass({
        op: "budget",
        within: false,
        origin: "agent",
        flagOn: true,
        agentUnsure: false,
      }),
    ).toBe("meta_ads.update_ad_set_budget_review");
    expect(
      pickDecisionClass({
        op: "budget",
        within: true,
        origin: "agent",
        flagOn: true,
        agentUnsure: false,
      }),
    ).toBe("meta_ads.update_ad_set_budget");
  });

  it("absent origin/flagOn/agentUnsure → BYTE-IDENTICAL to the pre-feature matrix", () => {
    expect(pickDecisionClass({ op: "budget", within: true })).toBe(
      "meta_ads.update_ad_set_budget",
    );
    expect(pickDecisionClass({ op: "budget", within: false })).toBe(
      "meta_ads.update_ad_set_budget_review",
    );
  });
});

describe("pickDecisionClass — learning-phase step guard (forceApproval, strictly tightening)", () => {
  it("forceApproval → review even when WITHIN the dollar cap (auto would have applied)", () => {
    expect(
      pickDecisionClass({ op: "budget", within: true, forceApproval: true }),
    ).toBe("meta_ads.update_ad_set_budget_review");
  });

  it("forceApproval → review when over cap too (already review; stays review)", () => {
    expect(
      pickDecisionClass({ op: "budget", within: false, forceApproval: true }),
    ).toBe("meta_ads.update_ad_set_budget_review");
  });

  it("forceApproval BEATS the user-chat fast-path (a >30% step typed in chat is still gated)", () => {
    expect(
      pickDecisionClass({
        op: "budget",
        within: true,
        origin: "user_chat",
        flagOn: true,
        agentUnsure: false,
        forceApproval: true,
      }),
    ).toBe("meta_ads.update_ad_set_budget_review");
  });

  it("forceApproval:false → routing is byte-identical to without the field", () => {
    expect(
      pickDecisionClass({ op: "budget", within: true, forceApproval: false }),
    ).toBe("meta_ads.update_ad_set_budget");
    expect(
      pickDecisionClass({ op: "budget", within: false, forceApproval: false }),
    ).toBe("meta_ads.update_ad_set_budget_review");
    expect(
      pickDecisionClass({
        op: "budget",
        within: false,
        origin: "user_chat",
        flagOn: true,
        agentUnsure: false,
        forceApproval: false,
      }),
    ).toBe("meta_ads.update_ad_set_budget");
  });
});

describe("pickDecisionClass — status", () => {
  it("routes PAUSE to auto WHEN the tenant has opted in (cap.enabled=true)", () => {
    expect(
      pickDecisionClass({ op: "status", status: "PAUSED", capEnabled: true }),
    ).toBe("meta_ads.set_status");
  });

  it("routes PAUSE to review when no cap row / cap.enabled=false (safe default)", () => {
    expect(
      pickDecisionClass({ op: "status", status: "PAUSED", capEnabled: false }),
    ).toBe("meta_ads.set_status_review");
  });

  it("routes ACTIVE to review regardless of cap.enabled (resume always operator-gated)", () => {
    expect(
      pickDecisionClass({ op: "status", status: "ACTIVE", capEnabled: true }),
    ).toBe("meta_ads.set_status_review");
    expect(
      pickDecisionClass({ op: "status", status: "ACTIVE", capEnabled: false }),
    ).toBe("meta_ads.set_status_review");
  });
});

describe("pickDecisionClass — create", () => {
  it("routes to the PARKED strategist class (gate-by-construction; raw create is never returned)", () => {
    expect(pickDecisionClass({ op: "create" })).toBe("perfmkt.create_ad_set_pending_strategist");
    expect(pickDecisionClass({ op: "create" })).not.toBe("meta_ads.create_ad_set");
  });
});
