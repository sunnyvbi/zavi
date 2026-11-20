import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/tools/growth/native_funnel", async () => {
  const actual = await vi.importActual<
    typeof import("@/services/tools/growth/native_funnel")
  >("@/services/tools/growth/native_funnel");
  return {
    ...actual,
    readNativeFunnel: vi.fn(),
  };
});
vi.mock("@/services/mcp/internal/operator-db", () => ({
  callOperatorDbTool: vi.fn(),
}));

import { diagnoseFunnelTool } from "../diagnose_funnel";
import { readNativeFunnel } from "@/services/tools/growth/native_funnel";
import { callOperatorDbTool } from "@/services/mcp/internal/operator-db";
import { queryFunnelByGeoCategoryTool } from "@/services/tools/operator-db/aggregates";

const readNative = readNativeFunnel as unknown as ReturnType<typeof vi.fn>;
const callOpDb = callOperatorDbTool as unknown as ReturnType<typeof vi.fn>;

const ctx = { tenant_id: "tenant-A", log: () => {} };
const noNative = { has_data: false, tenant_id: "tenant-A", window: "30 days", steps: [] };
const fail = (error: string) => ({ ok: false, is_error: true, content: JSON.stringify({ error, message: "x" }) });
const ok = (body: unknown) => ({ ok: true, is_error: false, content: JSON.stringify(body) });

describe("diagnoseFunnelTool source priority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PREFERS the native funnel when it has data", async () => {
    readNative.mockResolvedValueOnce({
      has_data: true,
      tenant_id: "tenant-A",
      window: "30 days",
      total_events_in_window: 10,
      steps: [{ event: "signup", count: 5, conversion_from_top: 1 }],
    });
    const out = (await diagnoseFunnelTool.execute(ctx, {})) as {
      diagnosis_source: string;
    };
    expect(out.diagnosis_source).toBe("native_events");
    expect(callOpDb).not.toHaveBeenCalled();
  });

  it("FALLS BACK to the operator-DB funnel when native has no data", async () => {
    readNative.mockResolvedValueOnce(noNative);
    callOpDb.mockResolvedValueOnce(ok({ rows: [{ city: "SF", book_n: 3 }] }));
    const out = (await diagnoseFunnelTool.execute(ctx, {})) as {
      diagnosis_source: string;
    };
    expect(out.diagnosis_source).toBe("operator_db_query_funnel_by_geo_category");
    expect(callOpDb).toHaveBeenCalledTimes(1);
  });
});

describe("diagnoseFunnelTool honest errors (B1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readNative.mockResolvedValue(noNative);
  });

  it("no DB at all -> operator_db_not_connected", async () => {
    callOpDb.mockResolvedValueOnce(fail("operator_db_not_connected"));
    await expect(diagnoseFunnelTool.execute(ctx, {})).rejects.toMatchObject({ code: "operator_db_not_connected" });
  });

  it("a connected DB whose read fails -> operator_db_read_failed with the reason, never not_connected", async () => {
    callOpDb.mockResolvedValueOnce(fail("operator_db_schema_map_missing"));
    await expect(diagnoseFunnelTool.execute(ctx, {})).rejects.toMatchObject({
      code: "operator_db_read_failed",
      meta: { reason: "operator_db_schema_map_missing" },
    });
  });

  it("an unexpected driver throw (SQL error) -> operator_db_read_failed, not a crash", async () => {
    class PgError extends Error {}
    callOpDb.mockRejectedValueOnce(new PgError("relation does not exist"));
    await expect(diagnoseFunnelTool.execute(ctx, {})).rejects.toMatchObject({
      code: "operator_db_read_failed",
      meta: { reason: "driver_error:PgError" },
    });
  });

  it("Mongo (no funnel aggregate) falls back to signup + booking window counts", async () => {
    callOpDb
      .mockResolvedValueOnce(fail("operator_db_aggregate_not_yet_implemented"))
      .mockResolvedValueOnce(ok({ ok: true, data: { available: true, window_days: 30, count: 412 } }))
      .mockResolvedValueOnce(ok({ ok: true, data: { available: false, reason: "not_available", window_days: 30, count: 0 } }));
    const out = (await diagnoseFunnelTool.execute(ctx, {})) as {
      diagnosis_source: string;
      funnel: { signups: number | null; bookings: number | null; window_days: number };
    };
    expect(out.diagnosis_source).toBe("operator_db_window_counts");
    expect(out.funnel).toEqual({ window_days: 30, signups: 412, bookings: null });
    expect(callOpDb).toHaveBeenCalledWith("tenant-A", "query_new_users", { window_days: 30 });
    expect(callOpDb).toHaveBeenCalledWith("tenant-A", "query_new_bookings", { window_days: 30 });
  });

  it("a DB type with no funnel read and no count read -> operator_db_unsupported_for_db_type", async () => {
    callOpDb
      .mockResolvedValueOnce(fail("operator_db_aggregate_not_yet_implemented"))
      .mockResolvedValueOnce(fail("operator_db_aggregate_not_yet_implemented"))
      .mockResolvedValueOnce(fail("operator_db_aggregate_not_yet_implemented"));
    await expect(diagnoseFunnelTool.execute(ctx, {})).rejects.toMatchObject({
      code: "operator_db_unsupported_for_db_type",
    });
  });

  it("Mongo fallback counts that are both unavailable (driver error swallowed) -> operator_db_read_failed", async () => {
    callOpDb
      .mockResolvedValueOnce(fail("operator_db_aggregate_not_yet_implemented"))
      .mockResolvedValueOnce(ok({ ok: true, data: { available: false, reason: "not_available", window_days: 30, count: 0 } }))
      .mockResolvedValueOnce(ok({ ok: true, data: { available: false, reason: "not_available", detail: "date_field_is_string", window_days: 30, count: 0 } }));
    await expect(diagnoseFunnelTool.execute(ctx, {})).rejects.toMatchObject({
      code: "operator_db_read_failed",
    });
  });

  it("Mongo fallback counts that both FAIL -> operator_db_read_failed, not unsupported", async () => {
    callOpDb
      .mockResolvedValueOnce(fail("operator_db_aggregate_not_yet_implemented"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"));
    await expect(diagnoseFunnelTool.execute(ctx, {})).rejects.toMatchObject({
      code: "operator_db_read_failed",
    });
  });
});

describe("diagnoseFunnelTool geo/category filters (B2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readNative.mockResolvedValue(noNative);
  });

  it("maps geo/category onto the aggregate's focus_city/focus_category", async () => {
    callOpDb.mockResolvedValueOnce(ok({ rows: [] }));
    await diagnoseFunnelTool.execute(ctx, { geo: "Austin", category: "SUV" });
    expect(callOpDb).toHaveBeenCalledWith("tenant-A", "query_funnel_by_geo_category", {
      focus_city: "Austin",
      focus_category: "SUV",
    });
  });

  it("the aggregate input rejects unknown keys instead of silently dropping them", () => {
    expect(() => queryFunnelByGeoCategoryTool.input_schema.parse({ geo: "Austin" })).toThrow();
    expect(() => queryFunnelByGeoCategoryTool.input_schema.parse({ focus_city: "Austin" })).not.toThrow();
  });
});
