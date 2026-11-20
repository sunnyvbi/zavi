
import { describe, it, expect } from "vitest";
import {
  runSummary,
  runCaveat,
  runBreakdown,
  runReadsNotDone,
  findingBand,
  type RecipeFindingView,
} from "./recipeStep";

const legacyBody = {
  step: { title: "Check which conversion events are firing", body: "..." },
  position: 1,
  of: 5,
  action_key: "393da68751ff49ec",
  rendered_markdown: "## Scoreboard\n\nPrior decisions: 4 measured outcomes...",
};

describe("run-level blocks — a body that predates them", () => {
  it("returns nothing for every block, so nothing is drawn", () => {
    expect(runSummary(legacyBody)).toBeNull();
    expect(runCaveat(legacyBody)).toBeNull();
    expect(runBreakdown(legacyBody)).toBeNull();
    expect(runReadsNotDone(legacyBody)).toEqual([]);
  });

  it("does not throw on a body with the keys present but garbage", () => {
    const junk = { summary: 7, caveat: "no", breakdown: [], reads_not_done: {} };
    expect(runSummary(junk)).toBeNull();
    expect(runCaveat(junk)).toBeNull();
    expect(runBreakdown(junk)).toBeNull();
    expect(runReadsNotDone(junk)).toEqual([]);
  });
});

describe("a row that carries no block at all", () => {
  const carries = (b: Record<string, unknown>) =>
    runSummary(b) !== null ||
    runCaveat(b) !== null ||
    runBreakdown(b) !== null ||
    runReadsNotDone(b).length > 0;

  it("is false for a legacy body", () => {
    expect(carries(legacyBody)).toBe(false);
  });

  it("is true as soon as any ONE block is present", () => {
    expect(
      carries({ ...legacyBody, reads_not_done: [{ what: "w", why: "y" }] }),
    ).toBe(true);
    expect(
      carries({ ...legacyBody, summary: { label: "L", value: "V", context: "C" } }),
    ).toBe(true);
  });
});

describe("runSummary", () => {
  it("reads the figure with its label and context", () => {
    expect(
      runSummary({
        summary: { label: "Return", value: "1.05x", context: "on $4,150.77 across 22 purchases" },
      }),
    ).toEqual({ label: "Return", value: "1.05x", unit: null, context: "on $4,150.77 across 22 purchases" });
  });

  it("drops the whole block when any of the three is missing", () => {
    expect(runSummary({ summary: { value: "1.05x", context: "on spend" } })).toBeNull();
    expect(runSummary({ summary: { label: "Return", context: "on spend" } })).toBeNull();
    expect(runSummary({ summary: { label: "Return", value: "1.05x" } })).toBeNull();
  });
});

describe("runCaveat", () => {
  it("carries the impact when the agent said what ignoring it costs", () => {
    const c = runCaveat({
      caveat: {
        title: "Every return figure here is Meta-attributed only",
        detail: "Three pixels found, all degraded.",
        impact: "Do not cut a campaign on these numbers yet.",
      },
    });
    expect(c?.impact).toBe("Do not cut a campaign on these numbers yet.");
  });

  it("is still valid with no impact", () => {
    expect(runCaveat({ caveat: { title: "t", detail: "d" } })?.impact).toBeNull();
  });
});

describe("runBreakdown", () => {
  const good = {
    breakdown: {
      title: "Money map",
      columns: ["Campaign", "Posture", "Return"],
      rows: [
        { cells: ["Gig Rentals Purchase", "Hold", "6.24x"], status: "pass" },
        { cells: ["Turo comparison", "Investigate", "no signal"], status: "fail" },
      ],
    },
  };

  it("reads a well-formed table", () => {
    const b = runBreakdown(good);
    expect(b?.columns).toEqual(["Campaign", "Posture", "Return"]);
    expect(b?.rows).toHaveLength(2);
    expect(b?.rows[0].status).toBe("pass");
  });

  it("DROPS a row whose cell count does not match the columns", () => {
    const b = runBreakdown({
      breakdown: {
        title: "Money map",
        columns: ["A", "B", "C"],
        rows: [{ cells: ["1", "2", "3"] }, { cells: ["1", "2"] }, { cells: ["1", "2", "3", "4"] }],
      },
    });
    expect(b?.rows).toHaveLength(1);
  });

  it("caps at 4 columns and 8 rows so it cannot push the actions off screen", () => {
    const b = runBreakdown({
      breakdown: {
        title: "Wide",
        columns: ["a", "b", "c", "d", "e", "f"],
        rows: Array.from({ length: 20 }, () => ({ cells: ["1", "2", "3", "4"] })),
      },
    });
    expect(b?.columns).toHaveLength(4);
    expect(b?.rows).toHaveLength(8);
  });

  it("is null when every row was dropped, rather than an empty table", () => {
    expect(
      runBreakdown({ breakdown: { title: "T", columns: ["A", "B"], rows: [{ cells: ["only one"] }] } }),
    ).toBeNull();
  });
});

describe("runReadsNotDone", () => {
  it("keeps what, why and the impact", () => {
    const r = runReadsNotDone({
      reads_not_done: [
        { what: "Landing match", why: "/rent and /about both 404", impact: "Every click from that campaign is lost." },
      ],
    });
    expect(r).toHaveLength(1);
    expect(r[0].impact).toBe("Every click from that campaign is lost.");
  });

  it("skips an entry missing what or why, and caps the list at 6", () => {
    const r = runReadsNotDone({
      reads_not_done: [
        { why: "no what" },
        ...Array.from({ length: 9 }, (_, i) => ({ what: `w${i}`, why: "because" })),
      ],
    });
    expect(r).toHaveLength(6);
    expect(r.every((x) => x.what.startsWith("w"))).toBe(true);
  });
});

describe("findingBand with direction", () => {
  const f = (over: Partial<RecipeFindingView>): RecipeFindingView => ({
    metricId: "m",
    status: "failing",
    value: "v",
    numericValue: null,
    target: null,
    unit: null,
    direction: null,
    blocks: [],
    access: null,
    risk: null,
    doNothing: null,
    undo: null,
    ...over,
  });

  it("lower-better: frequency over its threshold fails", () => {
    expect(findingBand(f({ numericValue: 4.11, target: 3.5, direction: "lte" }))).toBe("warn");
    expect(findingBand(f({ numericValue: 9, target: 3.5, direction: "lte" }))).toBe("fail");
    expect(findingBand(f({ numericValue: 2.1, target: 3.5, direction: "lte" }))).toBe("pass");
  });

  it("higher-better: the same numbers read the opposite way", () => {
    expect(findingBand(f({ numericValue: 6.24, target: 3.5, direction: "gte" }))).toBe("pass");
    expect(findingBand(f({ numericValue: 1.0, target: 3.5, direction: "gte" }))).toBe("fail");
  });

  it("falls back to magnitude closeness when direction is absent", () => {
    expect(findingBand(f({ numericValue: 4.11, target: 3.5 }))).toBe("warn");
    expect(findingBand(f({ numericValue: 40, target: 3.5 }))).toBe("fail");
  });

  it("draws nothing without both numbers, whatever the direction says", () => {
    expect(findingBand(f({ numericValue: 4.11, direction: "lte" }))).toBeNull();
    expect(findingBand(f({ target: 3.5, direction: "lte" }))).toBeNull();
  });
});
