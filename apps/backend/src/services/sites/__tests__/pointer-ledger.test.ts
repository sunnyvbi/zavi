import { describe, expect, it, vi } from "vitest";
import { createSitePointerLedger } from "../pointer-ledger";

const T = "11111111-1111-4111-8111-111111111111";
const S = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("SitePointerLedger", () => {
  it("markProjected / noteDrift call the tenant-scoped RPCs and return the count (-1 = row moved)", async () => {
    const rpc = vi.fn(async (_t: unknown, name: string) => ({ data: name === "site_mark_host_projected" ? -1 : 2, error: null }));
    const l = createSitePointerLedger({ rpc, publicRpc: vi.fn() });
    expect(await l.markProjected(T, S, 7, true)).toBe(-1);
    expect(rpc).toHaveBeenCalledWith(T, "site_mark_host_projected", { p_site_id: S, p_version: 7, p_drift: true });
    expect(await l.noteDrift(T, S)).toBe(2);
    expect(rpc).toHaveBeenLastCalledWith(T, "site_note_projection_drift", { p_site_id: S });
  });

  it("an RPC error or a non-count answer throws (never read as 'in sync')", async () => {
    const l1 = createSitePointerLedger({ rpc: async () => ({ data: null, error: { message: "boom" } }), publicRpc: vi.fn() });
    await expect(l1.markProjected(T, S, 0, false)).rejects.toThrow(/site_mark_host_projected failed: boom/);
    await expect(l1.markProjected(T, S, -1, false)).rejects.toThrow(/needs a host_version/);
    const l2 = createSitePointerLedger({ rpc: async () => ({ data: null, error: null }), publicRpc: vi.fn() });
    await expect(l2.noteDrift(T, S)).rejects.toThrow(/returned no count/);
  });

  it("driftBatch clamps the limit and keeps only (tenant_id, site_id)", async () => {
    const publicRpc = vi.fn(async () => ({
      data: [{ tenant_id: T, site_id: S, hostname: "leak.zaviagent.com" }, { tenant_id: T }],
      error: null,
    }));
    const l = createSitePointerLedger({ rpc: vi.fn(), publicRpc });
    expect(await l.driftBatch("2026-10-01T00:00:00Z", 10_000)).toEqual([{ tenant_id: T, site_id: S }]);
    expect(publicRpc).toHaveBeenCalledWith("site_projection_drift_batch", { p_settle_before: "2026-10-01T00:00:00Z", p_limit: 500 });
  });
});
