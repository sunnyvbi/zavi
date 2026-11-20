import { describe, it, expect } from "vitest";
import { deriveDispatchStage, isStuckEligibleStage, isPreMergedStage } from "../roadmap";

describe("isStuckEligibleStage — a finished no-ship success is NOT stuck", () => {
  it("only dispatched (hung) and pr_open (unreviewed) are stuck-eligible", () => {
    expect(isStuckEligibleStage("dispatched")).toBe(true);
    expect(isStuckEligibleStage("pr_open")).toBe(true);
  });
  it("engineer_done is EXCLUDED (finished success, no PR = deliberate no-ship / writeback-lost, not a review stall)", () => {
    expect(isStuckEligibleStage("engineer_done")).toBe(false);
    expect(isPreMergedStage("engineer_done")).toBe(true);
  });
  it("terminal stages are not stuck", () => {
    expect(isStuckEligibleStage("merged")).toBe(false);
    expect(isStuckEligibleStage("closed_unmerged")).toBe(false);
    expect(isStuckEligibleStage("failed_to_open")).toBe(false);
  });
});

describe("deriveDispatchStage — a success run with no PR is engineer_done (the root)", () => {
  it("success + finished + no pr_url → engineer_done (so it is now NOT stuck-eligible)", () => {
    const stage = deriveDispatchStage({ status: "success", finished_at: "2026-07-05T00:00:00Z", parsed: {} });
    expect(stage).toBe("engineer_done");
    expect(isStuckEligibleStage(stage)).toBe(false);
  });
  it("success + a real pr_url → pr_open (still stuck-eligible if it sits)", () => {
    const stage = deriveDispatchStage({
      status: "success",
      finished_at: "2026-07-05T00:00:00Z",
      parsed: { pr_url: "https://github.com/o/r/pull/1" },
    });
    expect(stage).toBe("pr_open");
    expect(isStuckEligibleStage(stage)).toBe(true);
  });
  it("never-finished dispatch → dispatched (hung → stuck-eligible)", () => {
    const stage = deriveDispatchStage({ status: "running", finished_at: null, parsed: {} });
    expect(stage).toBe("dispatched");
    expect(isStuckEligibleStage(stage)).toBe(true);
  });
});
