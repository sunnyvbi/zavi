import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ rpc: (...a: unknown[]) => rpc(...a) }) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));
vi.mock("../hints", async (orig) => ({
  ...(await orig<typeof import("../hints")>()),
  refineHintsWithHaiku: async () => ({ users: { table: "users", id_field: "id" }, _confidence: { users: 0.9 } }),
}));

import { persistIntrospection, SOURCE_CHANGED_DISCOVERY } from "../index";

const raw = {
  dialect: "postgres",
  tables: [{ name: "users", columns: [{ name: "id", type: "integer", nullable: false }], rowEstimate: 1 }],
  skippedUnsafeNames: 0,
  namesSeenTotal: 1,
  deadlineHit: false,
  listingTruncated: false,
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hint refinement write", () => {
  it("goes through apply_tenant_db_scan with the same generation", async () => {
    rpc.mockResolvedValue({ data: "stored", error: null });
    const out = await persistIntrospection("t1", "postgres", raw, Date.now() + 60_000, 7);
    expect(out).toMatchObject({ ok: true, tables_found: 1 });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["apply_tenant_db_scan", "apply_tenant_db_scan"]);
    expect(rpc.mock.calls[1]![1]).toMatchObject({ p_generation: 7, p_hints: expect.objectContaining({ users: { table: "users", id_field: "id" } }) });
  });

  it("a transition between the two writes makes the result source_changed", async () => {
    rpc.mockResolvedValueOnce({ data: "stored", error: null }).mockResolvedValueOnce({ data: "stale", error: null });
    expect(await persistIntrospection("t1", "postgres", raw, Date.now() + 60_000, 7)).toEqual({ ok: false, discovery_error: SOURCE_CHANGED_DISCOVERY });
  });
});
