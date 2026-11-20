import { describe, it, expect } from "vitest";
import { computeLevers, type MetricRunner, type ComputeInput } from "../compute";
import type { CanonicalMap } from "../mapping";

const NOW = 1_760_000_000_000;

function runner(over: Partial<MetricRunner> = {}): MetricRunner {
  return {
    count: async () => 0,
    distinctCount: async () => 0,
    distinctJoinMatched: async () => ({ matched: 0, attempted: 0 }),
    groupCount: async () => ({ groups: [], truncated: false }),
    ...over,
  };
}

const FULL_MAP: CanonicalMap = {
  listings: { table: "listings", label: "L", id_field: "id" },
  bookings: { table: "bookings", label: "B", created_at_field: "created_at", listing_ref_field: "listing_id" },
  cancellations: { table: "cancellations", label: "C", reason_field: "cancel_reason", created_at_field: "created_at" },
};

function input(over: Partial<ComputeInput> = {}): ComputeInput {
  return { map: FULL_MAP, dialect: "mongodb", window_days: 30, runner: runner(), ...over };
}

describe("computeLevers — idle-supply", () => {
  it("computes idle fraction, passes contract, rankable", async () => {
    const r = runner({
      count: async (coll, filter) => {
        if (coll === "listings") return 100;
        if (coll === "bookings" && filter && "listing_id" in filter) return 3;
        if (coll === "bookings") return 200;
        return 0;
      },
      distinctJoinMatched: async () => ({ matched: 70, attempted: 74 }),
    });
    const out = await computeLevers(input({ runner: r }), NOW);
    const idle = out.candidates.find((c) => c.constraint === "idle-supply")!;
    expect(idle.numerator).toBe(30);
    expect(idle.denominator).toBe(100);
    expect(idle.metric_probe_passed).toBe(true);
    expect(idle.source_quality).toBe("confirmed_live_mongo");
    expect(idle.live_validated).toBe(true);
    expect(out.metrics.find((m) => m.lever === "idle-supply")).toBeTruthy();
  });

  it("ranks idle-supply when there are ZERO bookings in the window (all idle)", async () => {
    const r = runner({
      count: async (coll) => (coll === "listings" ? 100 : 0),
      distinctJoinMatched: async () => ({ matched: 0, attempted: 0 }),
    });
    const out = await computeLevers(input({ runner: r }), NOW);
    const idle = out.candidates.find((c) => c.constraint === "idle-supply")!;
    expect(idle.numerator).toBe(100);
    expect(idle.denominator).toBe(100);
    expect(idle.metric_probe_passed).toBe(true);
  });

  it("abstains join_unavailable when the join can't be computed safely (non-scalar-id type / truncation)", async () => {
    const r = runner({
      count: async (coll) => (coll === "listings" ? 100 : 5),
      distinctJoinMatched: async () => ({ matched: 0, attempted: 0, unavailable: true }),
    });
    const out = await computeLevers(input({ runner: r }), NOW);
    const idle = out.candidates.find((c) => c.constraint === "idle-supply")!;
    expect(idle.abstain_reason).toBe("join_unavailable");
  });

  it("abstains no_data when listings/bookings mapping is incomplete", async () => {
    const map: CanonicalMap = { bookings: { table: "bookings", label: "B", created_at_field: "created_at" } };
    const out = await computeLevers(input({ map }), NOW);
    const idle = out.candidates.find((c) => c.constraint === "idle-supply")!;
    expect(idle.abstain_reason).toBe("no_data");
  });
});

describe("computeLevers — verification-cancel-leak", () => {
  it("computes the verification share via exact k-anon bucket counts, rankable", async () => {
    const r = runner({
      groupCount: async () => ({ groups: [
        { value: "identity verification failed", count: 20 },
        { value: "guest cancelled, changed plans", count: 80 },
      ], truncated: false }),
      count: async () => 500,
    });
    const out = await computeLevers(input({ runner: r }), NOW);
    const leak = out.candidates.find((c) => c.constraint === "verification-cancel-leak")!;
    expect(leak.numerator).toBe(20);
    expect(leak.denominator).toBe(500);
    expect(leak.k_anon_passed).toBe(true);
    expect(leak.metric_probe_passed).toBe(true);
  });

  it("abstains k_anon_below_threshold when the verification cohort is sub-k", async () => {
    const out = await computeLevers(
      input({
        runner: runner({
          groupCount: async () => ({ groups: [
            { value: "kyc failed", count: 2 },
            { value: "changed plans", count: 80 },
          ], truncated: false }),
          count: async () => 500,
        }),
      }),
      NOW,
    );
    const leak = out.candidates.find((c) => c.constraint === "verification-cancel-leak")!;
    expect(leak.k_anon_passed).toBe(false);
    expect(leak.abstain_reason).toBe("k_anon_below_threshold");
  });

  it("abstains reason_field_truncated when the reason $group is capped (codex P2)", async () => {
    const out = await computeLevers(
      input({
        runner: runner({
          groupCount: async () => ({ groups: [{ value: "verification failed", count: 10 }], truncated: true }),
          count: async () => 500,
        }),
      }),
      NOW,
    );
    const leak = out.candidates.find((c) => c.constraint === "verification-cancel-leak")!;
    expect(leak.abstain_reason).toBe("reason_field_truncated");
  });

  it("scopes reason population to in-window rows WITH a reason, dual date repr (codex P1+P2)", async () => {
    let captured: Record<string, unknown> | undefined;
    const r = runner({
      groupCount: async (_c, _f, filter) => {
        captured = filter;
        return { groups: [{ value: "verification failed", count: 10 }, { value: "changed plans", count: 90 }], truncated: false };
      },
      count: async () => 500,
    });
    await computeLevers(input({ runner: r }), NOW);
    expect((captured as any).cancel_reason).toEqual({ $nin: [null, ""] });
    const branches = (captured as any).$or as { created_at?: { $gte?: unknown } }[];
    expect(Array.isArray(branches)).toBe(true);
    expect(branches.some((b) => b.created_at?.$gte instanceof Date)).toBe(true);
    expect(branches.some((b) => typeof b.created_at?.$gte === "string")).toBe(true);
    const numeric = branches.filter((b) => typeof b.created_at?.$gte === "number");
    expect(numeric).toHaveLength(2);
    expect(numeric.some((b) => (b.created_at as any).$lt === 1_000_000_000_000)).toBe(true);
  });

  it("abstains no_cancellation_mapping when reason field is unmapped", async () => {
    const map: CanonicalMap = {
      listings: { table: "listings", label: "L", id_field: "id" },
      bookings: { table: "bookings", label: "B", created_at_field: "created_at" },
      cancellations: { table: "cancellations", label: "C" },
    };
    const out = await computeLevers(input({ map }), NOW);
    const leak = out.candidates.find((c) => c.constraint === "verification-cancel-leak")!;
    expect(leak.abstain_reason).toBe("no_cancellation_mapping");
  });

  it("does NOT leak raw reason strings into any candidate/metric output", async () => {
    const out = await computeLevers(
      input({
        runner: runner({
          groupCount: async () => ({ groups: [
            { value: "IDENTITY VERIFICATION failed for user 55123", count: 10 },
            { value: "plans changed for reservation 99", count: 90 },
          ], truncated: false }),
          count: async () => 500,
        }),
      }),
      NOW,
    );
    const serialized = JSON.stringify(out);
    expect(serialized).not.toMatch(/55123|reservation 99|IDENTITY VERIFICATION/i);
  });
});

describe("computeLevers — SQL / no runner", () => {
  it("SQL dialect → synthetic_only, not live-validated, requires_sql_validation", async () => {
    const out = await computeLevers(input({ dialect: "postgres", runner: null }), NOW);
    for (const c of out.candidates) {
      if (c.constraint === "idle-supply" || c.constraint === "verification-cancel-leak") {
        expect(c.source_quality).toBe("synthetic_only");
        expect(c.live_validated).toBe(false);
        expect(c.abstain_reason).toBe("requires_sql_validation");
      }
    }
    expect(out.metrics).toEqual([]);
  });
});
