import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/data-gateway", () => ({
  loadDbAccess: vi.fn(),
}));
vi.mock("@/services/tools/operator-db/catalog", () => ({
  getCatalog: vi.fn(),
}));
vi.mock("@/services/tools/operator-db/mapping", async () => {
  const actual = await vi.importActual<typeof import("@/services/tools/operator-db/mapping")>(
    "@/services/tools/operator-db/mapping",
  );
  return { ...actual, getConfirmedMapping: vi.fn() };
});
vi.mock("@/services/mcp/internal/operator-db", () => ({
  callOperatorDbTool: vi.fn(),
}));
vi.mock("@/services/tools/operator-db/compute", () => ({ computeLevers: vi.fn() }));
vi.mock("@/services/tools/operator-db/provenance", () => ({ recordProvenance: vi.fn() }));
vi.mock("@/services/tools/operator-db/metric-runner", () => ({ makeMongoRunner: vi.fn(() => ({})) }));

import { growthConstraintDiagnosisTool } from "../growth_constraint_diagnosis";
import { loadDbAccess as resolveOperatorDb } from "@/services/data-gateway";
import { getCatalog } from "@/services/tools/operator-db/catalog";
import { getConfirmedMapping } from "@/services/tools/operator-db/mapping";
import { callOperatorDbTool } from "@/services/mcp/internal/operator-db";
import { computeLevers } from "@/services/tools/operator-db/compute";
import { recordProvenance } from "@/services/tools/operator-db/provenance";

const resolveDb = resolveOperatorDb as unknown as ReturnType<typeof vi.fn>;
const getCat = getCatalog as unknown as ReturnType<typeof vi.fn>;
const getConfirmed = getConfirmedMapping as unknown as ReturnType<typeof vi.fn>;
const callOpDb = callOperatorDbTool as unknown as ReturnType<typeof vi.fn>;
const compute = computeLevers as unknown as ReturnType<typeof vi.fn>;
const recordProv = recordProvenance as unknown as ReturnType<typeof vi.fn>;

function rankableCandidate(over: Record<string, unknown> = {}) {
  return {
    constraint: "idle-supply", numerator: 30, denominator: 100,
    source_quality: "confirmed_live_mongo", confirmed_map: true,
    metric_probe_passed: true, k_anon_passed: true, live_validated: true,
    query_id: "idle-supply:listings-vs-booked",
    elasticity_hint: "hint", build_cost_hint: "low", ...over,
  };
}

const ctx = { tenant_id: "tenant-A", log: () => {} };

const HINTS_GOOD = {
  bookings: {
    table: "bookings",
    created_at_field: "created_at",
    geo_field: "city",
    gmv_proxy_field: "amount",
  },
  cancellations: { table: "bookings", status_field: "status", reason_field: "cancel_reason" },
  _confidence: {},
};

function sampleRows(rows: Record<string, unknown>[]) {
  callOpDb.mockResolvedValue({
    ok: true,
    is_error: false,
    content: JSON.stringify({
      ok: true,
      data: { collection: "bookings", row_count: rows.length, truncated: false, rows },
    }),
    ms: 1,
  });
}

describe("growth_constraint_diagnosis — confirm-mapping gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveDb.mockResolvedValue({ config: { type: "mongodb" }, connectionString: "x", driver: {} });
    getCat.mockResolvedValue({
      dialect: "mongodb", catalog: { tables: [] }, hints: HINTS_GOOD,
      catalog_hash: "hash-abc", discovery_error: null, updated_at: null,
    });
    compute.mockResolvedValue({ candidates: [], metrics: [] });
  });

  it("UNCONFIRMED → requires_mapping_confirmation with a proposed map, no numbers", async () => {
    getConfirmed.mockResolvedValue(null);
    sampleRows([{ created_at: "2026-06-01T00:00:00Z", amount: 40, city: "SF", status: "active", cancel_reason: "no_show" }]);

    const out = (await growthConstraintDiagnosisTool.execute(ctx, {})) as any;
    expect(out.status).toBe("requires_mapping_confirmation");
    expect(out.catalog_hash).toBe("hash-abc");
    expect(out.proposed_map.bookings.table).toBe("bookings");
    expect(out.proposed_map.cancellations.reason_field).toBe("cancel_reason");
    expect(out.looks_wrong).toBe(false);
    expect(out.constraints).toBeUndefined();
  });

  it("UNCONFIRMED + mis-mapped date field → looks_wrong true (created_at → array)", async () => {
    getConfirmed.mockResolvedValue(null);
    sampleRows([
      { created_at: [1710000000, 1710000100], amount: 40, city: "SF" },
      { created_at: [], amount: 55, city: "LA" },
    ]);

    const out = (await growthConstraintDiagnosisTool.execute(ctx, {})) as any;
    expect(out.status).toBe("requires_mapping_confirmation");
    expect(out.looks_wrong).toBe(true);
    const dateProbe = out.probes.find((p: any) => p.field_key === "created_at_field");
    expect(dateProbe.ok).toBe(false);
  });

  it("CONFIRMED + a rankable lever → diagnosed, ranked constraints + provenance written", async () => {
    getConfirmed.mockResolvedValue({
      catalog_hash: "hash-abc",
      confirmed_at: "2026-07-04T00:00:00Z",
      confirmed_map: {
        bookings: { table: "bookings", label: "B", created_at_field: "created_at" },
        cancellations: { table: "bookings", label: "C", reason_field: "cancel_reason" },
      },
    });
    sampleRows([{ created_at: "2026-06-01T00:00:00Z", cancel_reason: "verification_failed" }]);
    compute.mockResolvedValue({
      candidates: [
        rankableCandidate(),
        { constraint: "thin-funnel", numerator: 0, denominator: 0, source_quality: "confirmed_live_mongo",
          confirmed_map: true, metric_probe_passed: false, k_anon_passed: true, live_validated: true, abstain_reason: "no_data" },
      ],
      metrics: [{ lever: "idle-supply", result: { lever: "idle-supply", numerator: 30, denominator: 100, window_days: 30, numerator_window_days: 30, denominator_window_days: 30, query_id: "idle-supply:listings-vs-booked", source: "listings+bookings" } }],
    });

    const ctxWithRun = { ...ctx, run_id: "run-123" };
    const out = (await growthConstraintDiagnosisTool.execute(ctxWithRun, {})) as any;
    expect(out.status).toBe("diagnosed");
    expect(out.constraints).toHaveLength(1);
    expect(out.constraints[0].constraint).toBe("idle-supply");
    expect(out.constraints[0].rank).toBe(1);
    expect(out.constraints[0].evidence.query_id).toBe("idle-supply:listings-vs-booked");
    expect(out.abstained.map((a: any) => a.constraint)).toContain("thin-funnel");
    expect(recordProv).toHaveBeenCalledTimes(1);
    expect(recordProv.mock.calls[0][1]).toBe("run-123");
  });

  it("writes-suppressed run (draft / variants lab) → diagnosed, NO provenance write", async () => {
    getConfirmed.mockResolvedValue({
      catalog_hash: "hash-abc",
      confirmed_at: "2026-07-04T00:00:00Z",
      confirmed_map: {
        bookings: { table: "bookings", label: "B", created_at_field: "created_at" },
        cancellations: { table: "bookings", label: "C", reason_field: "cancel_reason" },
      },
    });
    sampleRows([{ created_at: "2026-06-01T00:00:00Z", cancel_reason: "verification_failed" }]);
    compute.mockResolvedValue({
      candidates: [rankableCandidate()],
      metrics: [{ lever: "idle-supply", result: { lever: "idle-supply", numerator: 30, denominator: 100, window_days: 30, numerator_window_days: 30, denominator_window_days: 30, query_id: "idle-supply:listings-vs-booked", source: "listings+bookings" } }],
    });
    const out = (await growthConstraintDiagnosisTool.execute({ ...ctx, run_id: "run-123", writes_suppressed: true }, {})) as any;
    expect(out.status).toBe("diagnosed");
    expect(recordProv).not.toHaveBeenCalled();
  });

  it("CONFIRMED but a blocking date probe fails → abstain WITHOUT computing (false-zero guard, codex P1)", async () => {
    getConfirmed.mockResolvedValue({
      catalog_hash: "hash-abc",
      confirmed_at: "2026-07-04T00:00:00Z",
      confirmed_map: { bookings: { table: "bookings", label: "B", created_at_field: "created_at" } },
    });
    sampleRows([{ created_at: [1710000000, 1710000100] }, { created_at: [] }]);

    const out = (await growthConstraintDiagnosisTool.execute(ctx, {})) as any;
    expect(out.status).toBe("requires_mapping_confirmation");
    expect(out.looks_wrong).toBe(true);
    expect(out.constraints).toEqual([]);
    expect(out.abstained.every((a: any) => a.reason === "mapping_looks_wrong")).toBe(true);
    expect(compute).not.toHaveBeenCalled();
  });

  it("CONFIRMED + all abstained → diagnosed, empty constraints, abstained surfaced", async () => {
    getConfirmed.mockResolvedValue({
      catalog_hash: "hash-abc",
      confirmed_at: "2026-07-04T00:00:00Z",
      confirmed_map: { bookings: { table: "bookings", label: "B", created_at_field: "created_at" } },
    });
    sampleRows([{ created_at: "2026-06-01T00:00:00Z" }]);
    compute.mockResolvedValue({
      candidates: [
        { constraint: "verification-cancel-leak", numerator: 0, denominator: 0, source_quality: "confirmed_live_mongo",
          confirmed_map: true, metric_probe_passed: false, k_anon_passed: true, live_validated: true, abstain_reason: "no_cancellation_mapping" },
      ],
      metrics: [],
    });

    const out = (await growthConstraintDiagnosisTool.execute(ctx, {})) as any;
    expect(out.status).toBe("diagnosed");
    expect(out.constraints).toEqual([]);
    const cancel = out.abstained.find((a: any) => a.constraint === "verification-cancel-leak");
    expect(cancel.reason).toBe("no_cancellation_mapping");
    expect(recordProv).not.toHaveBeenCalled();
  });

  it("SQL dialect → sample_unavailable probe, still gates (no crash)", async () => {
    getConfirmed.mockResolvedValue(null);
    callOpDb.mockResolvedValue({ ok: false, is_error: true, content: JSON.stringify({ error: "operator_db_query_dialect_unsupported" }), ms: 1 });

    const out = (await growthConstraintDiagnosisTool.execute(ctx, {})) as any;
    expect(out.status).toBe("requires_mapping_confirmation");
    expect(out.probes.some((p: any) => p.reason === "sample_unavailable")).toBe(true);
    expect(out.looks_wrong).toBe(false);
    expect(out.probes_available).toBe(false);
    expect(out.message).toMatch(/could not be sampled|review it carefully/i);
  });

  it("CONFIRMED map with a null role entry does not crash (RPC permits null)", async () => {
    getConfirmed.mockResolvedValue({
      catalog_hash: "hash-abc",
      confirmed_at: "2026-07-04T00:00:00Z",
      confirmed_map: {
        bookings: { table: "bookings", label: "B", created_at_field: "created_at" },
        cancellations: null,
      },
    });
    sampleRows([{ created_at: "2026-06-01T00:00:00Z" }]);

    const out = (await growthConstraintDiagnosisTool.execute(ctx, {})) as any;
    expect(out.status).toBe("diagnosed");
  });
});
