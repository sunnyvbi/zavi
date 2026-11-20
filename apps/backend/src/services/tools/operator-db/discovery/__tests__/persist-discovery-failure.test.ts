import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const update = vi.fn();
const eq = vi.fn();
const from = vi.fn();

const logEvent = vi.fn(async (_e: Record<string, unknown>) => undefined);
vi.mock("@/services/logging/logEvent", () => ({ logEvent: (e: Record<string, unknown>) => logEvent(e) }));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: (...a: unknown[]) => rpc(...a),
    from: (t: string) => {
      from(t);
      return { update: (patch: unknown) => { update(patch); return { eq: (c: string, v: string) => { eq(c, v); return Promise.resolve({ error: null }); } }; } };
    },
  }),
}));

import { persistDiscoveryFailure, persistIntrospection, persistDiscoveryError, applyScan, RESCAN_KEPT_LAST_GOOD } from "../index";

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: "stored", error: null });
});

const applied = () => rpc.mock.calls.filter((c) => c[0] === "apply_tenant_db_scan").map((c) => c[1] as Record<string, unknown>);

describe("persistDiscoveryFailure", () => {
  it("NEVER calls set_tenant_db_catalog — that RPC replaces the catalog outright", async () => {
    await persistDiscoveryFailure("t1", "postgres", "no_secret", 3);
    expect(rpc.mock.calls.some((c) => c[0] === "set_tenant_db_catalog")).toBe(false);
  });

  it("records the failure through the keep-last-good write, fenced on the generation", async () => {
    await persistDiscoveryFailure("t1", "postgres", "no_secret", 3);
    expect(applied()).toEqual([
      { p_tenant_id: "t1", p_dialect: "postgres", p_catalog: {}, p_hints: {}, p_discovery_error: "no_secret", p_coverage: {}, p_generation: 3 },
    ]);
  });

  it("never throws — it runs on an already-failing path", async () => {
    rpc.mockImplementationOnce(() => { throw new Error("db down"); });
    await expect(persistDiscoveryFailure("t1", "mysql", "not_connected", 1)).resolves.toBeUndefined();
  });
});

describe("discovery writes are compare-and-set on the generation (final review finding 2)", () => {
  const raw = { dialect: "postgres", tables: [{ name: "users", columns: [{ name: "id", type: "integer", nullable: false }], rowEstimate: 1 }], skippedUnsafeNames: 0, namesSeenTotal: 1, deadlineHit: false, listingTruncated: false } as never;
  it("must-catch: a stale worker's catalog write loses; no refinement write follows", async () => {
    rpc.mockResolvedValue({ data: "stale", error: null });
    const out = await persistIntrospection("t1", "postgres", raw, Date.now() + 60_000, 2);
    expect(out).toEqual({ ok: false, discovery_error: "source_changed" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_generation: 2 });
  });
  it("must-catch: a stale failure never overwrites a newer catalog", async () => {
    rpc.mockResolvedValue({ data: "stale", error: null });
    expect(await persistDiscoveryError("t1", "postgres", new Error("boom"), 2)).toEqual({ ok: false, discovery_error: "source_changed" });
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_generation: 2 });
  });
  it("must-not-catch: a current worker's write lands", async () => {
    const out = await persistIntrospection("t1", "postgres", raw, Date.now(), 2);
    expect(out).toMatchObject({ ok: true, tables_found: 1 });
  });
});

describe("a failed or empty re-scan keeps the last good catalog (2026-10-13 outage)", () => {
  const raw = (tables: number, deadlineHit = false) =>
    ({
      dialect: "mongodb",
      tables: Array.from({ length: tables }, (_, i) => ({ name: `c${i}`, columns: [{ name: "_id", type: "ObjectId", nullable: false }], rowEstimate: null })),
      skippedUnsafeNames: 0,
      namesSeenTotal: Math.max(tables, 3),
      deadlineHit,
      listingTruncated: false,
    }) as never;

  it("must-catch: a failed scan with a last good catalog reports kept_last_good and leaves a warn row", async () => {
    rpc.mockResolvedValue({ data: "kept_last_good", error: null });
    const out = await persistDiscoveryError("t1", "mongodb", new Error("PlanExecutor error during aggregation :: caused by :: operation exceeded time limit"), 4);
    expect(out).toMatchObject({ ok: false, kept_last_good: true });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", code: "rescan_kept_last_good", tenant_id: "t1" }));
  });

  it("must-catch: an empty scan kept the last good catalog: no refinement write, reported as kept", async () => {
    rpc.mockResolvedValue({ data: "kept_last_good", error: null });
    const out = await persistIntrospection("t1", "mongodb", raw(0, true), Date.now() + 60_000, 4);
    expect(out).toEqual({ ok: false, discovery_error: RESCAN_KEPT_LAST_GOOD, kept_last_good: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(applied()[0]).toMatchObject({ p_discovery_error: null, p_catalog: { tables: [] }, p_coverage: expect.objectContaining({ deadline_hit: true }), p_generation: 4 });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "rescan_kept_last_good", meta: expect.objectContaining({ tables_found: 0 }) }));
  });

  it("a first discovery that fails is stored as the failure and logged as an error", async () => {
    rpc.mockResolvedValue({ data: "stored_error", error: null });
    const out = await persistDiscoveryError("t1", "postgres", new Error("connect ECONNREFUSED"), 1);
    expect(out).toMatchObject({ ok: false });
    expect(out).not.toHaveProperty("kept_last_good");
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "discovery_failed" }));
  });

  it("must-not-catch: a full scan is stored and leaves no warning", async () => {
    const out = await persistIntrospection("t1", "mongodb", raw(3), Date.now(), 4);
    expect(out).toMatchObject({ ok: true, tables_found: 3 });
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("gives way to a transition holding the row lock, then retries (the retry answers stale)", async () => {
    vi.useFakeTimers();
    try {
      rpc
        .mockResolvedValueOnce({ data: null, error: { code: "55P03", message: "canceling statement due to lock timeout" } })
        .mockResolvedValueOnce({ data: "stale", error: null });
      const p = applyScan("t1", "postgres", { tables: [] }, {}, "boom", {}, 1);
      await vi.runAllTimersAsync();
      expect(await p).toBe("stale");
      expect(applied()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a write that keeps failing on locks surfaces the error after its retries", async () => {
    vi.useFakeTimers();
    try {
      rpc.mockResolvedValue({ data: null, error: { code: "40P01", message: "deadlock detected" } });
      const p = applyScan("t1", "postgres", { tables: [] }, {}, "boom", {}, 1);
      const settled = p.catch((e: Error) => e);
      await vi.runAllTimersAsync();
      expect(String(await settled)).toMatch(/deadlock detected/);
      expect(applied()).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unexpected RPC answer is an error, never read as stored", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(applyScan("t1", "postgres", { tables: [] }, {}, null, {}, 1)).rejects.toThrow(/returned true/);
  });

  it("a failing write never throws out of the failure path", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    await expect(persistDiscoveryError("t1", "postgres", new Error("x"), 1)).resolves.toMatchObject({ ok: false });
    await expect(persistDiscoveryFailure("t1", "postgres", "no_secret", 1)).resolves.toBeUndefined();
  });
});
