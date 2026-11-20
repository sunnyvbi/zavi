import { describe, expect, it } from "vitest";
import { pickRevisionReplacement } from "../../routes/agents/proposals";

const baseRevision = {
  id: "rev-1",
  decision_id: "dec-A",
  agent_run_id: "run-1",
  thread_id: null,
  status: "running",
  message: "cut spend by half",
  original_decision_class: "meta_ads.set_status",
  original_handler: null,
  original_body: { object_id: "camp-1", level: "campaign" },
  assistant_text: null,
  replacement_decision_id: null,
  last_error: null,
  created_at: "2026-06-07T00:00:00.000Z",
} as Parameters<typeof pickRevisionReplacement>[0];

const otherTargetDecision = {
  id: "new-dec",
  agent_run_id: "run-1",
  decision_class: "meta_ads.update_ad_set_budget",
  body: { ad_set_id: "adset-99", daily_budget_usd: 20 },
  status: "proposed",
  emitted_at: "2026-06-07T00:01:00.000Z",
};

describe("pickRevisionReplacement lineage gate", () => {
  it("accepts single cross-class replacement when the run explicitly revises THIS decision", () => {
    expect(pickRevisionReplacement(baseRevision, [otherTargetDecision], "dec-A")?.id).toBe("new-dec");
  });

  it("WITHHOLDS the single-emit fallback when the run revises a DIFFERENT decision", () => {
    expect(pickRevisionReplacement(baseRevision, [otherTargetDecision], "dec-OTHER")).toBeNull();
  });

  it("preserves pre-lineage behavior when lineage is unknown (null)", () => {
    expect(pickRevisionReplacement(baseRevision, [otherTargetDecision], null)?.id).toBe("new-dec");
    expect(pickRevisionReplacement(baseRevision, [otherTargetDecision])?.id).toBe("new-dec");
  });

  const sameTarget = {
    id: "same",
    agent_run_id: "run-1",
    decision_class: "meta_ads.set_status",
    body: { object_id: "camp-1", level: "campaign", status: "PAUSED" },
    status: "proposed",
    emitted_at: "2026-06-07T00:02:00.000Z",
  };

  it("accepts a SAME-target match when lineage matches or is unknown", () => {
    expect(pickRevisionReplacement(baseRevision, [otherTargetDecision, sameTarget], "dec-A")?.id).toBe("same");
    expect(pickRevisionReplacement(baseRevision, [otherTargetDecision, sameTarget], null)?.id).toBe("same");
  });

  it("WITHHOLDS even a same-target match when lineage explicitly mismatches (money-path guard)", () => {
    expect(pickRevisionReplacement(baseRevision, [otherTargetDecision, sameTarget], "dec-OTHER")).toBeNull();
  });

  it("refuses ambiguous multi-emit with no target match", () => {
    const second = { ...otherTargetDecision, id: "third", body: { ad_set_id: "adset-7", daily_budget_usd: 5 } };
    expect(pickRevisionReplacement(baseRevision, [otherTargetDecision, second], "dec-A")).toBeNull();
  });
});
