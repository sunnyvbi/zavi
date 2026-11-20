import { describe, expect, it } from "vitest";
import {
  EMPTY_REVISION_BASELINE,
  advanceRevisionBaseline,
  busyRefineKey,
  gainedBusyRefine,
  landedRefine,
  previewPathToOpen,
  safePreviewPath,
  type BuildRefine,
  type RevisionBaseline,
} from "./useBuildSession";

function refine(over: Partial<BuildRefine> & { id: string }): BuildRefine {
  return { message: "m", status: "done", created_at: "2026-09-29T10:00:00Z", ...over };
}

describe("safePreviewPath", () => {
  it.each([
    ["/laptops", "/laptops"],
    [" /cart ", "/cart"],
    ["/cart?x=1", "/cart?x=1"],
    ["/", "/"],
  ])("accepts %j", (raw, expected) => {
    expect(safePreviewPath(raw)).toBe(expected);
  });

  it.each([
    "//evil.com",
    "javascript:alert(1)",
    "../x",
    "/a/../../x",
    "https://evil.com/laptops",
    "/\\evil.com",
    "/cart\r\n",
    "",
    `/${"a".repeat(400)}`,
  ])("rejects %j", (raw) => {
    expect(safePreviewPath(raw)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(safePreviewPath(null)).toBeNull();
    expect(safePreviewPath(undefined)).toBeNull();
    expect(safePreviewPath(42)).toBeNull();
  });
});

describe("landedRefine", () => {
  it("picks the newest finished change and skips reverts, running, failed and awaiting-review rows", () => {
    const rows = [
      refine({ id: "old", preview_path: "/old" }),
      refine({ id: "shipped", preview_path: "/laptops" }),
      refine({ id: "review", awaiting_review: true }),
      refine({ id: "undo", kind: "undo" }),
      refine({ id: "restore", kind: "restore" }),
      refine({ id: "failed", status: "failed" }),
      refine({ id: "running", status: "active" }),
    ];
    expect(landedRefine(rows)?.id).toBe("shipped");
  });

  it("counts a finished live-edit draft as landed", () => {
    expect(landedRefine([refine({ id: "a" }), refine({ id: "d", draft: true })])?.id).toBe("d");
  });

  it("is null for an empty feed", () => {
    expect(landedRefine([])).toBeNull();
  });
});

describe("previewPathToOpen", () => {
  it("opens the change's route on the ship transition", () => {
    expect(previewPathToOpen("r0", "r1", "/laptops")).toBe("/laptops");
    expect(previewPathToOpen(null, "r1", "/laptops")).toBe("/laptops");
  });

  it("never navigates on first load, even when the newest change has a route", () => {
    expect(previewPathToOpen(undefined, "r1", "/laptops")).toBeNull();
  });

  it("does not re-navigate when the same change is polled again", () => {
    expect(previewPathToOpen("r1", "r1", "/laptops")).toBeNull();
  });

  it("stays on Home when the change has no route, targets Home, or the route is hostile", () => {
    expect(previewPathToOpen("r0", "r1", null)).toBeNull();
    expect(previewPathToOpen("r0", "r1", undefined)).toBeNull();
    expect(previewPathToOpen("r0", "r1", "/")).toBeNull();
    expect(previewPathToOpen("r0", "r1", "//evil.com")).toBeNull();
    expect(previewPathToOpen("r0", "r1", "javascript:alert(1)")).toBeNull();
  });

  it("does nothing when no change has landed", () => {
    expect(previewPathToOpen("r0", null, "/laptops")).toBeNull();
  });
});

describe("advanceRevisionBaseline", () => {
  function walk(steps: Array<[string | null, boolean, string | null]>): Array<string | null | undefined> {
    let b: RevisionBaseline = EMPTY_REVISION_BASELINE;
    return steps.map(([session, loaded, rev]) => {
      const { next, prior } = advanceRevisionBaseline(b, session, loaded, rev);
      b = next;
      return prior;
    });
  }

  it("takes the first loaded feed as the baseline and compares later feeds against it", () => {
    expect(walk([["s1", false, null], ["s1", true, "a"], ["s1", true, "b"]])).toEqual([undefined, undefined, "a"]);
  });

  it("ignores the stale feed a session switch briefly renders and re-baselines on the new session", () => {
    const priors = walk([
      ["s1", true, "a"],
      ["s2", true, "a"],
      ["s2", false, "a"],
      ["s2", true, "z"],
      ["s2", true, "y"],
    ]);
    expect(priors).toEqual([undefined, undefined, undefined, undefined, "z"]);
  });
});

describe("gainedBusyRefine", () => {
  const rows = (...s: Array<[string, string]>) => s.map(([id, status]) => refine({ id, status }));

  it("fires when a change starts that was not running before", () => {
    expect(gainedBusyRefine(busyRefineKey(rows(["a", "done"])), busyRefineKey(rows(["a", "done"], ["b", "active"])))).toBe(true);
  });

  it("stays quiet on the first read, on repeat polls and when a change finishes", () => {
    expect(gainedBusyRefine(undefined, busyRefineKey(rows(["b", "active"])))).toBe(false);
    expect(gainedBusyRefine("b", busyRefineKey(rows(["b", "active"])))).toBe(false);
    expect(gainedBusyRefine("b", busyRefineKey(rows(["b", "done"])))).toBe(false);
  });
});
