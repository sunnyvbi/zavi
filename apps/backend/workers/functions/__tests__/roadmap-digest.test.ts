import { describe, it, expect } from "vitest";
import {
  renderRoadmapDigestBlock,
  shouldRenderRoadmapDigest,
  type RoadmapDigestRow,
} from "../roadmap-digest";

describe("shouldRenderRoadmapDigest (weekly cadence)", () => {
  it("renders on Monday UTC, suppresses other days", () => {
    expect(shouldRenderRoadmapDigest(new Date("2026-06-08T13:00:00Z"))).toBe(true);
    expect(shouldRenderRoadmapDigest(new Date("2026-06-09T13:00:00Z"))).toBe(false);
    expect(shouldRenderRoadmapDigest(new Date("2026-06-13T13:00:00Z"))).toBe(false);
    expect(shouldRenderRoadmapDigest(new Date("2026-06-14T13:00:00Z"))).toBe(false);
  });
});

describe("renderRoadmapDigestBlock", () => {
  it("suppresses (returns '') when there are no rows", () => {
    expect(renderRoadmapDigestBlock([])).toBe("");
  });

  it("renders shipped/measured + in-flight + proposed with outcomes + deltas", () => {
    const rows: RoadmapDigestRow[] = [
      {
        theme: "checkout funnel drop",
        status: "measured",
        outcome: "won",
        baseline_query: "query_funnel_by_geo_category",
        baseline_value: 120,
      },
      {
        theme: "payout drift",
        status: "measured",
        outcome: "recurred",
        baseline_query: null,
        baseline_value: null,
      },
      { theme: "repo-hint relax", status: "in_flight", outcome: null, baseline_query: null, baseline_value: null },
      { theme: "empty-state polish", status: "proposed", outcome: null, baseline_query: null, baseline_value: null },
    ];
    const block = renderRoadmapDigestBlock(rows);
    expect(block).toContain("Product roadmap");
    expect(block).toContain("Measured:");
    expect(block).toContain("checkout funnel drop");
    expect(block).toContain("fix held");
    expect(block).toContain("tracking funnel");
    expect(block).toContain("baseline 120");
    expect(block).toContain("recurred");
    expect(block).toContain("In flight:");
    expect(block).toContain("repo-hint relax");
    expect(block).toContain("Proposed:");
    expect(block).toContain("empty-state polish");
  });

  it("renders only the populated sections", () => {
    const rows: RoadmapDigestRow[] = [
      { theme: "only in flight", status: "in_flight", outcome: null, baseline_query: null, baseline_value: null },
    ];
    const block = renderRoadmapDigestBlock(rows);
    expect(block).toContain("In flight:");
    expect(block).not.toContain("Measured:");
    expect(block).not.toContain("Proposed:");
  });

  it("caps proposed with a '+N more' tail", () => {
    const rows: RoadmapDigestRow[] = Array.from({ length: 6 }, (_, i) => ({
      theme: `proposed ${i}`,
      status: "proposed" as const,
      outcome: null,
      baseline_query: null,
      baseline_value: null,
    }));
    const block = renderRoadmapDigestBlock(rows);
    expect(block).toContain("+3 more proposed.");
  });

  it("suppresses when all rows are in an unknown status (no actionable bucket)", () => {
    const rows: RoadmapDigestRow[] = [
      { theme: "weird", status: "archived", outcome: null, baseline_query: null, baseline_value: null },
    ];
    expect(renderRoadmapDigestBlock(rows)).toBe("");
  });
});
