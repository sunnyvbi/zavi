import { describe, it, expect } from "vitest";
import { aggregateRunOutcome } from "../outcome-aggregate";

describe("aggregateRunOutcome", () => {
  it("accepted comes from acted (dispatch succeeded), dominating a mix", () => {
    expect(aggregateRunOutcome(["acted"])).toBe("accepted");
    expect(aggregateRunOutcome(["acted", "rejected"])).toBe("accepted");
    expect(aggregateRunOutcome(["rejected", "acted"])).toBe("accepted");
  });

  it("rejected when the only terminal status is rejection", () => {
    expect(aggregateRunOutcome(["rejected"])).toBe("rejected");
    expect(aggregateRunOutcome(["rejected", "rejected"])).toBe("rejected");
  });

  it("'approved' is transient — NOT a stampable accept (codex Slice-0 P1)", () => {
    expect(aggregateRunOutcome(["approved"])).toBeNull();
    expect(aggregateRunOutcome(["rejected", "approved"])).toBe("rejected");
    expect(aggregateRunOutcome(["approved", "acted"])).toBe("accepted");
  });

  it("null when no terminal-mapped status", () => {
    expect(aggregateRunOutcome(["proposed"])).toBeNull();
    expect(aggregateRunOutcome([])).toBeNull();
    expect(aggregateRunOutcome(["something_else"])).toBeNull();
  });
});
