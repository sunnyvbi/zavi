
import { describe, it, expect } from "vitest";
import {
  buildYesterdayLines,
  helpedRead,
  labelLine,
  type YesterdayGoalRow,
  type YesterdayLedgerRow,
  type YesterdayOutcomeRow,
} from "../digest-yesterday";

const ledgerRow = (over: Partial<YesterdayLedgerRow> = {}): YesterdayLedgerRow => ({
  action: "dispatched",
  target_agent_slug: "engineer",
  outcome: null,
  created_at: "2026-07-01T09:00:00Z",
  ...over,
});

const outcomeRow = (over: Partial<YesterdayOutcomeRow> = {}): YesterdayOutcomeRow => ({
  subject_name: "Summer promo campaign",
  action_class: "meta_ads.set_status",
  target_metric: "spend",
  decision_outcome: "approved",
  delta_metrics: { spend: -120 },
  ...over,
});

const goalRow = (over: Partial<YesterdayGoalRow> = {}): YesterdayGoalRow => ({
  objective: "Hit 200 signups",
  target_metric: "signups",
  current_value: 45,
  target_value: 200,
  status: "active",
  ...over,
});

describe("labelLine (provenance helper)", () => {
  it("suffixes each provenance label", () => {
    expect(labelLine("Spend went down.", "observed")).toBe("Spend went down. [observed]");
    expect(labelLine("Pause campaign X", "proposed")).toBe("Pause campaign X [proposed]");
    expect(labelLine("Looks like it helped.", "inferred")).toBe(
      "Looks like it helped. [inferred]",
    );
  });
});

describe("buildYesterdayLines — sections + labels (snapshot)", () => {
  it("renders ledger summary + reconciled outcome + helped read + goal progress", () => {
    const lines = buildYesterdayLines({
      ledger: [
        ledgerRow(),
        ledgerRow({ target_agent_slug: "growth-lead" }),
        ledgerRow({ action: "completed", outcome: "success" }),
        ledgerRow({ action: "dispatch_failed", outcome: "failed", target_agent_slug: null }),
      ],
      outcomes: [outcomeRow()],
      goals: [goalRow()],
    });
    expect(lines).toEqual([
      "Your team ran 2 autonomous tasks yesterday: 1 finished, 1 failed (engineer, growth-lead). [observed]",
      'After you approved "Summer promo campaign": spend changed by -$120.00 in the weeks after. [observed]',
      "Looks like it helped: spend went down. [inferred]",
      'Goal "Hit 200 signups": signups 45 of 200. [observed]',
    ]);
  });

  it("empty data renders honestly: no autonomous actions ran yesterday", () => {
    const lines = buildYesterdayLines({ ledger: [], outcomes: [], goals: [] });
    expect(lines).toEqual(["No autonomous actions ran yesterday. [observed]"]);
  });

  it("goal with null current_value renders 'unmeasured' (never invents a number)", () => {
    const lines = buildYesterdayLines({
      ledger: [],
      outcomes: [],
      goals: [goalRow({ current_value: null })],
    });
    expect(lines).toEqual([
      "No autonomous actions ran yesterday. [observed]",
      'Goal "Hit 200 signups": signups unmeasured. [observed]',
    ]);
    expect(lines.join("\n")).not.toContain("45");
  });

  it("reconcile-only ledger (nothing newly dispatched) says so instead of inventing runs", () => {
    const lines = buildYesterdayLines({
      ledger: [ledgerRow({ action: "reconcile", target_agent_slug: null })],
      outcomes: [],
      goals: [],
    });
    expect(lines).toEqual([
      "Autopilot checked in on running work; nothing new started. [observed]",
    ]);
  });

  it("outcome without a numeric delta stays [observed] and emits no inferred read", () => {
    const lines = buildYesterdayLines({
      ledger: [],
      outcomes: [outcomeRow({ delta_metrics: {} })],
      goals: [],
    });
    expect(lines).toEqual([
      "No autonomous actions ran yesterday. [observed]",
      'We measured "Summer promo campaign" after you approved it; no clear spend change to report yet. [observed]',
    ]);
    expect(lines.join("\n")).not.toContain("[inferred]");
  });

  it("every emitted line carries exactly one provenance label", () => {
    const lines = buildYesterdayLines({
      ledger: [ledgerRow(), ledgerRow({ action: "completed", outcome: "success" })],
      outcomes: [outcomeRow(), outcomeRow({ decision_outcome: "rejected" })],
      goals: [goalRow(), goalRow({ current_value: null, target_value: null })],
    });
    for (const l of lines) {
      expect(l).toMatch(/ \[(observed|proposed|inferred)\]$/);
    }
  });
});

describe("helpedRead — [inferred] kept to a minimum", () => {
  it("approved spend decrease → helped; increase → hedged", () => {
    expect(helpedRead(outcomeRow(), -50)).toBe("Looks like it helped: spend went down.");
    expect(helpedRead(outcomeRow(), 30)).toBe(
      "Spend still went up, so it may not have helped.",
    );
  });

  it("roas up → helped; down → hedged", () => {
    const o = outcomeRow({ target_metric: "roas" });
    expect(helpedRead(o, 0.4)).toBe("Looks like it helped: returns improved.");
    expect(helpedRead(o, -0.2)).toBe("Returns dipped, so it may not have helped.");
  });

  it("rejected decisions and unknown metrics get NO inferred read", () => {
    expect(helpedRead(outcomeRow({ decision_outcome: "rejected" }), -50)).toBeNull();
    expect(helpedRead(outcomeRow({ target_metric: "ctr" }), 1)).toBeNull();
  });
});
