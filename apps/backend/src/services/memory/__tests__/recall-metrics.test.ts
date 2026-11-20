import { describe, it, expect } from "vitest";
import {
  computeRecallMetric,
  type RecallMetricDeps,
  type RecallMetricRow,
} from "../recall-metrics";
import type { Golden } from "../recall-eval";

const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";

function golden(id: string, tenant: string, query: string, expected: string[], agent_slug: string): Golden {
  return { id, tenant_id: tenant, query, expected_note_ids: expected, agent_slug };
}

function makeDeps(
  goldens: Golden[],
  searchMap: Record<string, string[]>,
  captured: { row?: RecallMetricRow },
  now = () => new Date("2026-05-27T12:00:00Z"),
): RecallMetricDeps {
  return {
    loadGoldensForAgent: async () => goldens,
    search: async (_t, query) => (searchMap[query] ?? []).map((note_id) => ({ note_id })),
    verifyTenantNotes: async (_t, ids) => new Set(ids),
    upsertMetric: async (row) => {
      captured.row = row;
    },
    now,
  };
}

describe("computeRecallMetric", () => {
  it("all goldens hit top-3 → clean_grounded_rate 1.0, sample_size = N", async () => {
    const goldens = [
      golden("g1", T1, "q1", ["n1"], "operator"),
      golden("g2", T1, "q2", ["n2"], "operator"),
    ];
    const captured: { row?: RecallMetricRow } = {};
    const result = await computeRecallMetric(
      "operator",
      makeDeps(goldens, { q1: ["n1", "x"], q2: ["n2", "y"] }, captured),
    );
    expect(result.clean_grounded_rate).toBe(1);
    expect(result.sample_size).toBe(2);
    expect(result.agent_slug).toBe("operator");
    expect(result.run_date).toBe("2026-05-27");
    expect(captured.row).toEqual(result);
  });

  it("half the goldens miss top-3 → rate 0.5", async () => {
    const goldens = [
      golden("g1", T1, "q1", ["n1"], "engineer"),
      golden("g2", T1, "q2", ["n2"], "engineer"),
    ];
    const captured: { row?: RecallMetricRow } = {};
    const result = await computeRecallMetric(
      "engineer",
      makeDeps(goldens, { q1: ["n1"], q2: ["zz", "yy", "xx", "n2"] }, captured),
    );
    expect(result.clean_grounded_rate).toBe(0.5);
    expect(result.sample_size).toBe(2);
  });

  it("empty goldens → rate 0, sample_size 0, still upserts a row (no crash, no divide-by-zero)", async () => {
    const captured: { row?: RecallMetricRow } = {};
    const result = await computeRecallMetric("pm", makeDeps([], {}, captured));
    expect(result.clean_grounded_rate).toBe(0);
    expect(result.sample_size).toBe(0);
    expect(result.agent_slug).toBe("pm");
    expect(captured.row).toBeDefined();
    expect(captured.row!.sample_size).toBe(0);
  });

  it("aggregates across tenants by SUM of hits / SUM of goldens, not mean of rates", async () => {
    const goldens = [
      golden("a", T1, "qa", ["na"], "qa"),
      golden("b", T2, "qb", ["nb"], "qa"),
      golden("c", T2, "qc", ["nc"], "qa"),
      golden("d", T2, "qd", ["nd"], "qa"),
    ];
    const captured: { row?: RecallMetricRow } = {};
    const result = await computeRecallMetric(
      "qa",
      makeDeps(
        goldens,
        { qa: ["na"], qb: ["nb"], qc: ["miss"], qd: ["miss"] },
        captured,
      ),
    );
    expect(result.sample_size).toBe(4);
    expect(result.clean_grounded_rate).toBe(0.5);
  });

  it("honors an explicit run_date over now()", async () => {
    const goldens = [golden("g1", T1, "q1", ["n1"], "operator")];
    const captured: { row?: RecallMetricRow } = {};
    const result = await computeRecallMetric(
      "operator",
      makeDeps(goldens, { q1: ["n1"] }, captured),
      "2026-01-15",
    );
    expect(result.run_date).toBe("2026-01-15");
  });

  it("propagates a throwing loadGoldensForAgent (infra failure must NOT become a false zero metric)", async () => {
    const captured: { row?: RecallMetricRow } = {};
    const deps: RecallMetricDeps = {
      loadGoldensForAgent: async () => {
        throw new Error("DB read failed");
      },
      search: async () => [],
      verifyTenantNotes: async (_t, ids) => new Set(ids),
      upsertMetric: async (row) => {
        captured.row = row;
      },
    };
    await expect(computeRecallMetric("operator", deps)).rejects.toThrow("DB read failed");
    expect(captured.row).toBeUndefined();
  });

  it("propagates a throwing upsertMetric (persist failure must surface, not resolve successfully)", async () => {
    const goldens = [golden("g1", T1, "q1", ["n1"], "operator")];
    const deps: RecallMetricDeps = {
      loadGoldensForAgent: async () => goldens,
      search: async (_t, query) => (query === "q1" ? [{ note_id: "n1" }] : []),
      verifyTenantNotes: async (_t, ids) => new Set(ids),
      upsertMetric: async () => {
        throw new Error("upsert failed");
      },
    };
    await expect(computeRecallMetric("operator", deps)).rejects.toThrow("upsert failed");
  });

  it("clean_grounded_rate stays within [0,1] (the CHECK constraint's invariant)", async () => {
    const goldens = [
      golden("g1", T1, "q1", ["n1"], "operator"),
      golden("g2", T1, "q2", ["n2"], "operator"),
      golden("g3", T1, "q3", ["n3"], "operator"),
    ];
    const captured: { row?: RecallMetricRow } = {};
    const result = await computeRecallMetric(
      "operator",
      makeDeps(goldens, { q1: ["n1"], q2: ["miss"], q3: ["n3"] }, captured),
    );
    expect(result.clean_grounded_rate).toBeGreaterThanOrEqual(0);
    expect(result.clean_grounded_rate).toBeLessThanOrEqual(1);
    expect(result.clean_grounded_rate).toBeCloseTo(0.6667, 3);
  });
});
