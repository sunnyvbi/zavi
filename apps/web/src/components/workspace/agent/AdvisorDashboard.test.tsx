import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AdvisorDashboard,
  outcomeSegments,
  trackRecordTotal,
  outcomeBarLabel,
} from "./AdvisorDashboard";

describe("advisor accountability-bar helpers", () => {
  it("drops zero-count segments and keeps display order", () => {
    const segs = outcomeSegments({ acted: 3, rejected: 0, stale: 2, open: 1 });
    expect(segs.map((s) => s.key)).toEqual(["acted", "stale", "open"]);
    expect(segs.find((s) => s.key === "acted")?.count).toBe(3);
  });

  it("totals all four outcome buckets", () => {
    expect(trackRecordTotal({ acted: 9, rejected: 4, stale: 3, open: 5 })).toBe(21);
  });

  it("builds a words-only screen-reader sentence (never color-only)", () => {
    const label = outcomeBarLabel({ acted: 9, rejected: 4, stale: 3, open: 5 });
    expect(label).toContain("9 acted");
    expect(label).toContain("4 rejected");
    expect(label).toContain("3 stale");
    expect(label).toContain("5 open");
    expect(label).toContain("21");
  });

  it("handles an all-zero track record", () => {
    expect(trackRecordTotal({ acted: 0, rejected: 0, stale: 0, open: 0 })).toBe(0);
    expect(outcomeSegments({ acted: 0, rejected: 0, stale: 0, open: 0 })).toEqual([]);
    expect(outcomeBarLabel({ acted: 0, rejected: 0, stale: 0, open: 0 })).toMatch(
      /no prior recommendations/i,
    );
  });
});

describe("AdvisorDashboard renders without throwing", () => {
  it("static-renders (loading state)", () => {
    const html = renderToStaticMarkup(<AdvisorDashboard />);
    expect(typeof html).toBe("string");
  });
});
