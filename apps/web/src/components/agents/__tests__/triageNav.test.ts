
import { describe, it, expect } from "vitest";
import {
  flattenBuckets,
  clampIndex,
  keyToTriageAction,
  navigate,
  progressLabel,
  type TriageBucket,
} from "../triageNav";

function dec(id: string) {
  return {
    id,
    decision_class: "meta_ads.set_status",
    handler: "meta_ads.set_status",
    body: {},
    status: "proposed",
    emitted_at: "2026-06-20T00:00:00Z",
  };
}

const BUCKETS: TriageBucket[] = [
  { key: "pause", label: "Pausing", items: [dec("a"), dec("b")] },
  { key: "budget_up", label: "Raising", items: [dec("c")] },
];

describe("flattenBuckets", () => {
  it("flattens bucket order then item order, preserving sequence", () => {
    const flat = flattenBuckets(BUCKETS);
    expect(flat.map((f) => f.decision.id)).toEqual(["a", "b", "c"]);
    expect(flat[0].bucketLabel).toBe("Pausing");
    expect(flat[2].bucketLabel).toBe("Raising");
  });

  it("returns [] for no buckets", () => {
    expect(flattenBuckets([])).toEqual([]);
  });
});

describe("clampIndex", () => {
  it("clamps into [0,len-1]", () => {
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(1, 3)).toBe(1);
  });
  it("returns 0 for an empty list", () => {
    expect(clampIndex(2, 0)).toBe(0);
  });
});

describe("keyToTriageAction", () => {
  it("maps A/R/M case-insensitively", () => {
    expect(keyToTriageAction("a").kind).toBe("approve");
    expect(keyToTriageAction("A").kind).toBe("approve");
    expect(keyToTriageAction("r").kind).toBe("reject");
    expect(keyToTriageAction("R").kind).toBe("reject");
    expect(keyToTriageAction("m").kind).toBe("modify");
    expect(keyToTriageAction("M").kind).toBe("modify");
  });
  it("maps arrows to prev/next", () => {
    expect(keyToTriageAction("ArrowLeft").kind).toBe("prev");
    expect(keyToTriageAction("ArrowRight").kind).toBe("next");
  });
  it("returns none for unrelated keys (so the caller won't preventDefault)", () => {
    expect(keyToTriageAction("z").kind).toBe("none");
    expect(keyToTriageAction("Enter").kind).toBe("none");
    expect(keyToTriageAction(" ").kind).toBe("none");
  });
});

describe("navigate", () => {
  it("moves and clamps without wrapping", () => {
    expect(navigate(0, "next", 3)).toBe(1);
    expect(navigate(2, "next", 3)).toBe(2);
    expect(navigate(0, "prev", 3)).toBe(0);
    expect(navigate(1, "prev", 3)).toBe(0);
  });
});

describe("progressLabel", () => {
  it("renders 1-based position", () => {
    expect(progressLabel({ current: 2, total: 7, approved: 0, rejected: 0 })).toBe("3 of 7");
  });
  it("omits approved/rejected segments when zero", () => {
    expect(progressLabel({ current: 0, total: 5, approved: 0, rejected: 0 })).toBe("1 of 5");
  });
  it("includes counts when present", () => {
    expect(progressLabel({ current: 3, total: 7, approved: 2, rejected: 1 })).toBe(
      "4 of 7 · 2 approved · 1 rejected",
    );
  });
  it("handles an empty list", () => {
    expect(progressLabel({ current: 0, total: 0, approved: 0, rejected: 0 })).toBe("0 of 0");
  });
});
