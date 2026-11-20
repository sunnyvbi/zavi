import { describe, it, expect } from "vitest";
import { aggregateOperatorShapes, type OperatorShapeRow } from "../gaps";
import { OPERATOR_FAILURE_SHAPES } from "@/agents/operator/failure-shapes";

const KNOWN = OPERATOR_FAILURE_SHAPES;

function row(over: Partial<OperatorShapeRow>): OperatorShapeRow {
  return {
    status: "success",
    created_at: "2026-06-10T00:00:00.000Z",
    provenance: null,
    ...over,
  };
}

describe("aggregateOperatorShapes — operator P1-4 census rollup", () => {
  it("counts episodes per shape + tracks last_seen, sorted desc by count", () => {
    const rows: OperatorShapeRow[] = [
      row({ provenance: { failure_shapes: ["metric-mislabel"] }, created_at: "2026-06-08T00:00:00Z" }),
      row({ provenance: { failure_shapes: ["metric-mislabel"] }, created_at: "2026-06-10T00:00:00Z" }),
      row({ provenance: { failure_shapes: ["dead-end-punt"] }, created_at: "2026-06-09T00:00:00Z" }),
      row({ provenance: null }),
    ];
    const out = aggregateOperatorShapes(rows, KNOWN);
    expect(out.tagged_episodes).toBe(3);
    expect(out.by_shape[0]).toEqual({
      shape: "metric-mislabel",
      count: 2,
      last_seen: "2026-06-10T00:00:00Z",
    });
    expect(out.by_shape[1].shape).toBe("dead-end-punt");
  });

  it("a single episode tagged with two shapes counts once for tagged_episodes, once per shape", () => {
    const rows = [row({ provenance: { failure_shapes: ["capability-denial", "completeness-overclaim"] } })];
    const out = aggregateOperatorShapes(rows, KNOWN);
    expect(out.tagged_episodes).toBe(1);
    expect(out.by_shape.map((b) => b.shape).sort()).toEqual(
      ["capability-denial", "completeness-overclaim"],
    );
  });

  it("excludes trust_tier=3 rows (untrusted MCP/public)", () => {
    const rows = [
      row({ trust_tier: 3, provenance: { failure_shapes: ["metric-mislabel"] } }),
      row({ trust_tier: 1, provenance: { failure_shapes: ["metric-mislabel"] } }),
    ];
    const out = aggregateOperatorShapes(rows, KNOWN);
    expect(out.tagged_episodes).toBe(1);
  });

  it("drops non-taxonomy tags (defense in depth)", () => {
    const rows = [row({ provenance: { failure_shapes: ["metric-mislabel", "totally-made-up"] } })];
    const out = aggregateOperatorShapes(rows, KNOWN);
    expect(out.by_shape.map((b) => b.shape)).toEqual(["metric-mislabel"]);
  });

  it("malformed provenance.failure_shapes is ignored, not crashed", () => {
    const rows = [
      row({ provenance: { failure_shapes: "not-an-array" as unknown as string[] } }),
      row({ provenance: {} }),
    ];
    const out = aggregateOperatorShapes(rows, KNOWN);
    expect(out.tagged_episodes).toBe(0);
    expect(out.by_shape).toEqual([]);
  });
});
