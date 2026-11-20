
import { describe, it, expect } from "vitest";
import { isSeedRun, aggregateRuntime, type ValueReportRunInput } from "../value-report";

function run(p: Partial<ValueReportRunInput>): ValueReportRunInput {
  return {
    tenant_id: "t-1",
    agent_slug: "operator",
    agent_definition_hash: "real-hash",
    parsed: null,
    started_at: "2026-05-28T00:00:00.000Z",
    finished_at: "2026-05-28T00:01:00.000Z",
    ...p,
  };
}

describe("isSeedRun", () => {
  it("true when agent_definition_hash is seed-synthetic (even if parsed=null — failure seed row)", () => {
    expect(isSeedRun({ agent_definition_hash: "seed-synthetic", parsed: null })).toBe(true);
  });
  it("true when parsed.seed marker is set (success seed row)", () => {
    expect(isSeedRun({ agent_definition_hash: "seed-synthetic", parsed: { seed: true } })).toBe(true);
    expect(isSeedRun({ agent_definition_hash: "real-hash", parsed: { seed: true } })).toBe(true);
  });
  it("false for a real run (no seed hash, no marker)", () => {
    expect(isSeedRun({ agent_definition_hash: "real-hash", parsed: { foo: 1 } })).toBe(false);
    expect(isSeedRun({ agent_definition_hash: "real-hash", parsed: null })).toBe(false);
  });
});

describe("aggregateRuntime", () => {
  it("empty input → zero totals, empty rows", () => {
    expect(aggregateRuntime([])).toEqual({
      totals: { tenants: 0, runs: 0, runtime_seconds: 0 },
      rows: [],
    });
  });

  it("sums runtime per tenant over real runs", () => {
    const out = aggregateRuntime([
      run({ tenant_id: "t-1", started_at: "2026-05-28T00:00:00Z", finished_at: "2026-05-28T00:00:30Z" }),
      run({ tenant_id: "t-1", started_at: "2026-05-28T01:00:00Z", finished_at: "2026-05-28T01:01:00Z" }),
      run({ tenant_id: "t-2", started_at: "2026-05-28T02:00:00Z", finished_at: "2026-05-28T02:00:10Z" }),
    ]);
    expect(out.totals).toEqual({ tenants: 2, runs: 3, runtime_seconds: 100 });
    expect(out.rows[0]).toEqual({ tenant_id: "t-1", runs: 2, runtime_seconds: 90 });
    expect(out.rows[1]).toEqual({ tenant_id: "t-2", runs: 1, runtime_seconds: 10 });
  });

  it("EXCLUDES failure seed rows (parsed=null, seed-synthetic hash) — the Codex P2 case", () => {
    const out = aggregateRuntime([
      run({ tenant_id: "t-1", agent_definition_hash: "seed-synthetic", parsed: null,
            started_at: "2026-05-28T00:00:00Z", finished_at: "2026-05-28T05:00:00Z" }),
      run({ tenant_id: "t-1", started_at: "2026-05-28T00:00:00Z", finished_at: "2026-05-28T00:00:30Z" }),
    ]);
    expect(out.totals).toEqual({ tenants: 1, runs: 1, runtime_seconds: 30 });
  });

  it("EXCLUDES success seed rows (parsed.seed=true)", () => {
    const out = aggregateRuntime([
      run({ agent_definition_hash: "seed-synthetic", parsed: { seed: true },
            started_at: "2026-05-28T00:00:00Z", finished_at: "2026-05-28T09:00:00Z" }),
    ]);
    expect(out.totals.runs).toBe(0);
    expect(out.totals.runtime_seconds).toBe(0);
  });

  it("skips runs missing a timestamp (queued/running)", () => {
    const out = aggregateRuntime([
      run({ started_at: null, finished_at: null }),
      run({ started_at: "2026-05-28T00:00:00Z", finished_at: null }),
    ]);
    expect(out.totals.runs).toBe(0);
  });

  it("clamps negative duration to 0 (clock skew)", () => {
    const out = aggregateRuntime([
      run({ started_at: "2026-05-28T00:01:00Z", finished_at: "2026-05-28T00:00:00Z" }),
    ]);
    expect(out.totals.runtime_seconds).toBe(0);
    expect(out.totals.runs).toBe(1);
  });
});
