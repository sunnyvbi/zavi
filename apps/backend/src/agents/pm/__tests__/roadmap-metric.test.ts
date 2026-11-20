import { describe, it, expect } from "vitest";
import {
  toBaselineQueryName,
  comparableScalar,
  deriveBaselineFromTraces,
  classifyMetricMove,
  type OperatorDbTrace,
} from "../roadmap-metric";

describe("toBaselineQueryName", () => {
  it("maps the three named aggregate reads (any prefix) to their bare identity", () => {
    expect(toBaselineQueryName("operator_db_query_funnel_by_geo_category")).toBe(
      "query_funnel_by_geo_category",
    );
    expect(toBaselineQueryName("operator_db__query_recent_transactions")).toBe(
      "query_recent_transactions",
    );
    expect(toBaselineQueryName("query_active_supply_by_geo_category")).toBe(
      "query_active_supply_by_geo_category",
    );
  });
  it("returns null for non-baseline tools (catalog, per-row, non-operator)", () => {
    expect(toBaselineQueryName("operator_db_catalog")).toBeNull();
    expect(toBaselineQueryName("operator_db_query_user")).toBeNull();
    expect(toBaselineQueryName("memory_search")).toBeNull();
  });
});

describe("comparableScalar", () => {
  it("funnel → sum(book_n) across segments", () => {
    const parsed = {
      ok: true,
      data: { rows: [{ book_n: 10 }, { book_n: 5 }, { book_n: 0 }], truncated: false, total_segments_seen: 3 },
    };
    expect(comparableScalar("query_funnel_by_geo_category", parsed)).toBe(15);
  });
  it("active_supply → sum(active_listings_n)", () => {
    const parsed = { data: { rows: [{ active_listings_n: 7 }, { active_listings_n: 3 }] } };
    expect(comparableScalar("query_active_supply_by_geo_category", parsed)).toBe(10);
  });
  it("recent_transactions → row count of a flat array", () => {
    const parsed = { ok: true, data: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    expect(comparableScalar("query_recent_transactions", parsed)).toBe(3);
  });
  it("returns null when the shape is not a recognizable aggregate", () => {
    expect(comparableScalar("query_funnel_by_geo_category", { data: { not_rows: 1 } })).toBeNull();
    expect(comparableScalar("query_funnel_by_geo_category", null)).toBeNull();
    expect(comparableScalar("query_active_supply_by_geo_category", { data: { rows: [{ x: 1 }] } })).toBeNull();
  });
});

describe("deriveBaselineFromTraces", () => {
  it("picks the first successful named-query trace + its comparable scalar", () => {
    const traces: OperatorDbTrace[] = [
      { name: "operator_db_catalog", output_preview: "{}", status: "ok" },
      {
        name: "operator_db_query_funnel_by_geo_category",
        status: "ok",
        output_preview: JSON.stringify({ data: { rows: [{ book_n: 12 }, { book_n: 8 }] } }),
      },
    ];
    expect(deriveBaselineFromTraces(traces)).toEqual({
      baseline_query: "query_funnel_by_geo_category",
      baseline_value: 20,
    });
  });
  it("returns null when no named-query read ran (only catalog / per-row)", () => {
    const traces: OperatorDbTrace[] = [
      { name: "operator_db_catalog", output_preview: "{}", status: "ok" },
      { name: "operator_db_query_user", output_preview: "{}", status: "ok" },
    ];
    expect(deriveBaselineFromTraces(traces)).toBeNull();
  });
  it("returns null for empty / undefined traces (no operator_db this run)", () => {
    expect(deriveBaselineFromTraces([])).toBeNull();
    expect(deriveBaselineFromTraces(undefined)).toBeNull();
  });
  it("skips an ERRORED named-query trace", () => {
    const traces: OperatorDbTrace[] = [
      {
        name: "operator_db_query_funnel_by_geo_category",
        status: "tool_error",
        output_preview: JSON.stringify({ data: { rows: [{ book_n: 99 }] } }),
      },
    ];
    expect(deriveBaselineFromTraces(traces)).toBeNull();
  });
  it("skips a trace whose output_preview is truncated/invalid JSON", () => {
    const traces: OperatorDbTrace[] = [
      { name: "operator_db_query_funnel_by_geo_category", status: "ok", output_preview: "{ truncated…" },
    ];
    expect(deriveBaselineFromTraces(traces)).toBeNull();
  });
});

describe("classifyMetricMove", () => {
  it("flat when within the relative threshold", () => {
    expect(classifyMetricMove(100, 105)).toBe("flat");
    expect(classifyMetricMove(100, 100)).toBe("flat");
  });
  it("moved when beyond the relative threshold", () => {
    expect(classifyMetricMove(100, 130)).toBe("moved");
    expect(classifyMetricMove(100, 50)).toBe("moved");
  });
  it("flat when the absolute delta is below the abs floor (tiny baselines)", () => {
    expect(classifyMetricMove(2, 2.5)).toBe("flat");
  });
  it("moved on a small-baseline jump that clears both floors", () => {
    expect(classifyMetricMove(2, 5)).toBe("moved");
  });
});
