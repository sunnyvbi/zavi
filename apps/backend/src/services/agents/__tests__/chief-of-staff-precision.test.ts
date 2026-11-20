import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ serviceClient: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClient }));

import {
  computeCosDispatchPrecision,
  renderCosPrecisionBlock,
  COS_MIN_SETTLED_SAMPLE,
  type CosDispatchPrecision,
} from "../chief-of-staff-precision";

type DecRow = {
  body: unknown;
  status: string | null;
  emitted_at: string | null;
};

function decisionsClient(result: { data: DecRow[] | null; error: { message: string } | null }) {
  return {
    from: (_table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gt", "order", "limit"]) b[m] = () => b;
      b.then = (resolve: (r: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return b;
    },
  };
}

const NEUTRAL_FIELDS = { precision: null, settled: 0, accepted: 0, rejected: 0 };

describe("computeCosDispatchPrecision", () => {
  beforeEach(() => mocks.serviceClient.mockReset());

  it("returns neutral on an empty decisions table (new tenant)", async () => {
    mocks.serviceClient.mockReturnValue(decisionsClient({ data: [], error: null }));
    const p = await computeCosDispatchPrecision("t-1");
    expect(p).toMatchObject(NEUTRAL_FIELDS);
    expect(p.rejected_intents).toEqual([]);
  });

  it("fail-open: returns neutral (no nudge) when the read errors", async () => {
    mocks.serviceClient.mockReturnValue(decisionsClient({ data: null, error: { message: "boom" } }));
    const p = await computeCosDispatchPrecision("t-1");
    expect(p.precision).toBeNull();
    expect(p.rejected_intents).toEqual([]);
  });

  it("computes precision = accepted / settled; acted+approved are accepts, rejected is a reject", async () => {
    const rows: DecRow[] = [
      { body: { target_agent_slug: "dispute-response", intent: "a" }, status: "acted", emitted_at: "2026-06-09T10:00:00Z" },
      { body: { target_agent_slug: "performance-marketer", intent: "b" }, status: "approved", emitted_at: "2026-06-09T11:00:00Z" },
      { body: { target_agent_slug: "support-lead", intent: "c" }, status: "rejected", emitted_at: "2026-06-09T12:00:00Z" },
    ];
    mocks.serviceClient.mockReturnValue(decisionsClient({ data: rows, error: null }));
    const p = await computeCosDispatchPrecision("t-1");
    expect(p.accepted).toBe(2);
    expect(p.rejected).toBe(1);
    expect(p.settled).toBe(3);
    expect(p.precision).toBeCloseTo(2 / 3);
    expect(p.emitted).toBe(3);
  });

  it("EXCLUDES still-pending (proposed) rows from the settled denominator — a non-reading founder never poisons calibration", async () => {
    const rows: DecRow[] = [
      { body: { target_agent_slug: "a", intent: "x" }, status: "acted", emitted_at: "2026-06-09T10:00:00Z" },
      { body: { target_agent_slug: "a2", intent: "x2" }, status: "acted", emitted_at: "2026-06-09T10:30:00Z" },
      { body: { target_agent_slug: "b", intent: "y" }, status: "rejected", emitted_at: "2026-06-09T11:00:00Z" },
      { body: { target_agent_slug: "b2", intent: "y2" }, status: "rejected", emitted_at: "2026-06-09T11:30:00Z" },
      { body: { target_agent_slug: "c", intent: "z" }, status: "proposed", emitted_at: "2026-06-09T12:00:00Z" },
      { body: { target_agent_slug: "d", intent: "w" }, status: "proposed", emitted_at: "2026-06-09T13:00:00Z" },
    ];
    mocks.serviceClient.mockReturnValue(decisionsClient({ data: rows, error: null }));
    const p = await computeCosDispatchPrecision("t-1");
    expect(p.settled).toBe(4);
    expect(p.pending).toBe(2);
    expect(p.precision).toBeCloseTo(0.5);
  });

  it("EXCLUDES expired rows entirely (lapsed without a click is a weak signal, not a reject)", async () => {
    const rows: DecRow[] = [
      { body: { target_agent_slug: "a", intent: "x" }, status: "acted", emitted_at: "2026-06-09T10:00:00Z" },
      { body: { target_agent_slug: "a2", intent: "x2" }, status: "acted", emitted_at: "2026-06-09T10:10:00Z" },
      { body: { target_agent_slug: "a3", intent: "x3" }, status: "acted", emitted_at: "2026-06-09T10:20:00Z" },
      { body: { target_agent_slug: "b", intent: "y" }, status: "expired", emitted_at: "2026-06-09T11:00:00Z" },
    ];
    mocks.serviceClient.mockReturnValue(decisionsClient({ data: rows, error: null }));
    const p = await computeCosDispatchPrecision("t-1");
    expect(p.settled).toBe(3);
    expect(p.rejected).toBe(0);
    expect(p.precision).toBe(1);
  });

  it("precision is null below the settled-sample floor (too thin to calibrate)", async () => {
    expect(COS_MIN_SETTLED_SAMPLE).toBeGreaterThan(2);
    const rows: DecRow[] = [
      { body: { target_agent_slug: "a", intent: "x" }, status: "acted", emitted_at: "2026-06-09T10:00:00Z" },
      { body: { target_agent_slug: "b", intent: "y" }, status: "rejected", emitted_at: "2026-06-09T11:00:00Z" },
    ];
    mocks.serviceClient.mockReturnValue(decisionsClient({ data: rows, error: null }));
    const p = await computeCosDispatchPrecision("t-1");
    expect(p.settled).toBe(2);
    expect(p.precision).toBeNull();
    expect(p.rejected_intents).toHaveLength(1);
  });

  it("collects rejected intents verbatim with target + timestamp (capped)", async () => {
    const rows: DecRow[] = [
      { body: { target_agent_slug: "performance-marketer", intent: "Rebalance Meta spend — CAC +38%" }, status: "rejected", emitted_at: "2026-06-09T11:00:00Z" },
    ];
    mocks.serviceClient.mockReturnValue(decisionsClient({ data: rows, error: null }));
    const p = await computeCosDispatchPrecision("t-1");
    expect(p.rejected_intents[0]).toEqual({
      target_agent_slug: "performance-marketer",
      intent: "Rebalance Meta spend — CAC +38%",
      rejected_at: "2026-06-09T11:00:00Z",
    });
  });
});

describe("renderCosPrecisionBlock", () => {
  function p(over: Partial<CosDispatchPrecision>): CosDispatchPrecision {
    return {
      precision: null,
      settled: 0,
      accepted: 0,
      rejected: 0,
      emitted: 0,
      pending: 0,
      rejected_intents: [],
      ...over,
    };
  }

  it("returns '' when there is no actionable signal (thin sample, no rejections)", () => {
    expect(renderCosPrecisionBlock(p({}))).toBe("");
  });

  it("LOW acceptance → tells the model to TIGHTEN the gate", () => {
    const block = renderCosPrecisionBlock(
      p({ precision: 0.25, settled: 4, accepted: 1, rejected: 3 }),
    );
    expect(block).toContain("Promotion-gate calibration");
    expect(block).toContain("25%");
    expect(block).toMatch(/TIGHTEN/i);
  });

  it("HEALTHY acceptance → tells the model the gate is well-calibrated", () => {
    const block = renderCosPrecisionBlock(
      p({ precision: 0.9, settled: 10, accepted: 9, rejected: 1 }),
    );
    expect(block).toContain("90%");
    expect(block).toMatch(/HEALTHY/i);
  });

  it("notes still-pending dispatches are NOT counted", () => {
    const block = renderCosPrecisionBlock(
      p({ precision: 0.5, settled: 4, accepted: 2, rejected: 2, pending: 3 }),
    );
    expect(block).toContain("3 still pending");
    expect(block).toMatch(/not counted/i);
  });

  it("renders rejected intents as a recalibration correction even when precision is null (thin sample)", () => {
    const block = renderCosPrecisionBlock(
      p({
        precision: null,
        settled: 2,
        rejected_intents: [
          { target_agent_slug: "performance-marketer", intent: "Rebalance Meta", rejected_at: "2026-06-09T11:00:00Z" },
        ],
      }),
    );
    expect(block).toContain("REJECTED these dispatches");
    expect(block).toContain("performance-marketer");
    expect(block).toContain("Rebalance Meta");
    expect(block).toMatch(/do NOT re-promote/i);
  });
});
