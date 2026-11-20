import { describe, it, expect } from "vitest";

function pickPendingRun(
  newestFirstRunIds: string[],
  assistantRuns: Set<string>,
  stopped: Set<string>,
): string | undefined {
  return newestFirstRunIds.find(
    (id) => !assistantRuns.has(id) && !stopped.has(id),
  );
}

describe("pending-run pick (newest-first input)", () => {
  it("picks the NEWEST pending run when several are in flight", () => {
    const runs = ["run-new", "run-mid", "run-old"];
    const picked = pickPendingRun(runs, new Set(), new Set());
    expect(picked).toBe("run-new");
  });

  it("skips runs that already have an assistant reply", () => {
    const runs = ["run-new", "run-mid", "run-old"];
    const picked = pickPendingRun(runs, new Set(["run-new"]), new Set());
    expect(picked).toBe("run-mid");
  });

  it("skips runs the user explicitly stopped", () => {
    const runs = ["run-new", "run-mid"];
    const picked = pickPendingRun(runs, new Set(), new Set(["run-new"]));
    expect(picked).toBe("run-mid");
  });

  it("single in-flight run — the case that hid the bug — still works", () => {
    expect(pickPendingRun(["only"], new Set(), new Set())).toBe("only");
  });

  it("everything answered → nothing pending", () => {
    const runs = ["a", "b"];
    expect(pickPendingRun(runs, new Set(["a", "b"]), new Set())).toBeUndefined();
  });

  it("a reversed (oldest-first) read would pick the WRONG run — the old bug", () => {
    const newestFirst = ["run-new", "run-mid", "run-old"];
    const oldBehavior = [...newestFirst]
      .reverse()
      .find((id) => !new Set<string>().has(id));
    expect(oldBehavior).toBe("run-old");
    expect(pickPendingRun(newestFirst, new Set(), new Set())).toBe("run-new");
    expect(oldBehavior).not.toBe(
      pickPendingRun(newestFirst, new Set(), new Set()),
    );
  });
});
