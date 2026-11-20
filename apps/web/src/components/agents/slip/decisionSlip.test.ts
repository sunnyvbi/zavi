import { describe, expect, it } from "vitest";
import { approvedAtLabel, decisionSlipModel, makeReadGate, slipPlatform, slipStage } from "./decisionSlip";
import { slipSteps, slipStatusWord } from "../LiveDecisionCard";
import { monthMeter } from "../BudgetChoicePanel";

const googleRaise = {
  decision_class: "google_ads.update_campaign_budget_review",
  body: { campaign_id: "1", campaign_name: "Sales Search", daily_budget_usd: 150, expected_current_daily_budget_usd: 120 },
};

describe("decisionSlipModel", () => {
  it("leads a Google raise with the new daily budget, the old one and the change, platform named", () => {
    const m = decisionSlipModel(googleRaise, googleRaise.decision_class, "the app");
    expect(m.platform).toBe("Google Ads");
    expect(m.mark).toBe("G");
    expect(m.hero).toMatchObject({ amount: "$150", unit: "/day", was: "$120", chip: { text: "+$30/day", tone: "up" } });
    expect(m.primaryLabel).toBe("Approve $150/day");
    expect(m.steps).toEqual({ sending: "Sending to Google Ads", live: "Live on Google Ads" });
  });

  it("receipt claims only the ad change; the stamped limits are stated as 'now', never as changed, and no hold key", () => {
    const m = decisionSlipModel(
      { ...googleRaise, body: { ...googleRaise.body, budget_choice: { at: "2026-10-24T19:56:30Z", hold_idem: "x:raise", monthly_usd: 27100, daily_limit_usd: null } } },
      googleRaise.decision_class,
      "the app",
    );
    expect(m.receipt.rows).toHaveLength(1);
    expect(m.receipt.rows[0]).toMatchObject({ label: `${m.target} daily budget`, before: "$120", after: "$150/day" });
    expect(m.limitsNow).toEqual([{ label: "Monthly ad budget", value: "$27,100" }]);
    expect(JSON.stringify(m)).not.toContain("x:raise");
  });

  it("an app write's receipt lists every field it sent, in full", () => {
    const args = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, i === 7 ? "x".repeat(200) : i]));
    const m = decisionSlipModel({ decision_class: "composio.moves_money", body: { kind: "composio_write", app_name: "Square", arguments: args } }, "composio.execute_tool", "Square");
    expect(m.receipt.rows).toHaveLength(8);
    expect(m.receipt.rows[7].after).toBe("x".repeat(200));
  });

  it("an INR raise never shows a dollar sign", () => {
    const m = decisionSlipModel(
      { decision_class: "meta_ads.update_adset_budget_review", body: { adset_id: "9", adset_name: "Pune", daily_budget_usd: 2500, expected_current_daily_budget_usd: 2000, currency: "INR" } },
      "meta_ads.update_adset_budget",
      "the app",
    );
    expect(JSON.stringify(m.hero)).not.toContain("$");
    expect(m.primaryLabel).not.toContain("$");
  });

  it("a pause with no known budget has no amount (never $0)", () => {
    const m = decisionSlipModel({ decision_class: "meta_ads.set_status_review", body: { object_id: "1", object_name: "Leads", status: "PAUSED" } }, "meta_ads.set_status", "the app");
    expect(m.hero).toBeNull();
    expect(JSON.stringify(m)).not.toContain("$0");
  });

  it("a money-moving app write keeps every field and a visible risk flag", () => {
    const m = decisionSlipModel(
      { decision_class: "composio.moves_money", body: { kind: "composio_write", app_name: "Square", action: "Create refund", labels: ["moves_money"], arguments: { amount: 500, charge: "ch_1" } } },
      "composio.execute_tool",
      "Square",
    );
    expect(m.platform).toBe("Square");
    expect(m.flags).toContain("Moves money");
    expect(m.fields.map((f) => f.label)).toEqual(["amount", "charge"]);
    expect(m.primaryLabel).toBe("Approve");
    expect(m.receipt.title).toBe("What was sent");
  });
});

describe("slip stages and steps", () => {
  it("approved (queued) is not reported as sent; dispatching is", () => {
    expect(slipStage("running", "approved")).toBe("queued");
    expect(slipStage("running", "dispatching")).toBe("sending");
    const m = decisionSlipModel(googleRaise, googleRaise.decision_class, "the app");
    expect(slipSteps("queued", m, "the app", null)[1]).toMatchObject({ state: "now", sub: "Queued, about to send" });
  });

  it("outcome unknown never says nothing changed", () => {
    const m = decisionSlipModel({ decision_class: "composio.moves_money", body: { app_name: "Square" } }, "composio.execute_tool", "Square");
    const steps = slipSteps("unknown", m, "Square", null);
    expect(steps[1].state).toBe("warn");
    expect(JSON.stringify(steps)).not.toMatch(/nothing changed/i);
    expect(slipStatusWord("unknown", "Square", "dispatching")).toBe("Check Square");
  });

  it("superseded reads as out of date, not as a rejection", () => {
    expect(slipStatusWord("closed", "x", "superseded")).toBe("Closed, out of date");
    expect(slipStatusWord("rejected", "x", "rejected")).toBe("Rejected");
  });

  it("approval time comes from the row or is left out", () => {
    expect(approvedAtLabel(null)).toBeNull();
    expect(approvedAtLabel("not a date")).toBeNull();
    expect(approvedAtLabel("2026-10-24T19:56:30Z")).toMatch(/\d{1,2}:\d{2}/);
  });

  it("Meta/Google are named even though the outcome helper says 'the app'", () => {
    expect(slipPlatform("meta_ads.set_status_review", {}, "the app")).toBe("Meta Ads");
  });
});

describe("monthMeter", () => {
  const over = { kind: "over" as const, month_label: "October", projection_usd: 28319, monthly_usd: 27000, over_by_usd: 1319, raise_to_usd: 28400, daily_limit_usd: null, daily_limit_to_usd: null };
  it("draws against this month's cap (prorated first month)", () => {
    expect(monthMeter({ ...over, month_cap_usd: 13500, projection_usd: 14000 })?.cap).toBe(13500);
  });
  it("draws nothing for a set-aside or daily-limit-only block", () => {
    expect(monthMeter({ ...over, set_aside_over: true })).toBeNull();
    expect(monthMeter({ ...over, raise_to_usd: null })).toBeNull();
  });
});

describe("makeReadGate", () => {
  it("a tap invalidates every read already in flight", () => {
    const g = makeReadGate();
    const before = g.start();
    g.invalidate();
    expect(g.accept(before)).toBe(false);
    expect(g.accept(g.start())).toBe(true);
  });
  it("an older read lands while a newer one is still pending (no starvation)", () => {
    const g = makeReadGate();
    const a = g.start();
    g.start();
    expect(g.accept(a)).toBe(true);
  });
  it("an older read never overwrites a newer one already applied", () => {
    const g = makeReadGate();
    const a = g.start();
    const b = g.start();
    expect(g.accept(b)).toBe(true);
    expect(g.accept(a)).toBe(false);
  });
});
