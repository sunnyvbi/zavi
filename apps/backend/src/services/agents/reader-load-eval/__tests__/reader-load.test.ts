import { describe, it, expect } from "vitest";
import { scoreReaderLoad, isGraspable } from "../runner";
import { GOLDENS } from "../goldens";

describe("reader-load eval", () => {
  it("all goldens score as expected (100%)", () => {
    const r = scoreReaderLoad(GOLDENS);
    expect(r.accuracy).toBe(1);
    expect(r.passed).toBe(r.total);
  });
  it("a walling digest is not graspable; a short lead is", () => {
    expect(isGraspable("## Report\n### Section\nlots of stuff\n### More\nmore")).toBe(false);
    expect(isGraspable("Yes — doubled to $20/day.")).toBe(true);
    expect(
      isGraspable(
        "Ads ran 2.21x last week; one ad set is the drag — pausing it ~Jul 10. Decision: Bay Area hold or pause?",
      ),
    ).toBe(true);
  });
});
