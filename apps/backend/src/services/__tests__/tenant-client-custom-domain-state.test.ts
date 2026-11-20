import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ rows: [] as Row[], rpc: vi.fn() }));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => { filters.push([col, val]); return q; },
        single: async () => {
          const hit = table === "tenant_custom_domains"
            ? db.rows.filter((r) => filters.every(([c, v]) => r[c] === v))
            : [];
          return hit.length === 1 ? { data: hit[0], error: null } : { data: null, error: { message: "0 rows" } };
        },
      };
      return q;
    },
    rpc: (...a: unknown[]) => db.rpc(...a),
  }),
}));

import { asTenantId, setCustomDomainVerifyState } from "@/services/tenant-client";

describe("setCustomDomainVerifyState", () => {
  beforeEach(() => {
    db.rpc.mockReset().mockResolvedValue({ data: null, error: null });
    db.rows = [
      { id: "dom-a", tenant_id: "tenant-a" },
      { id: "dom-b", tenant_id: "tenant-b" },
    ];
  });

  it("writes verified through the service-role rpc for the tenant's own row", async () => {
    await setCustomDomainVerifyState(asTenantId("tenant-a"), { p_id: "dom-a", p_status: "verified", p_last_error: null });
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith("set_tenant_custom_domain_state", { p_id: "dom-a", p_status: "verified", p_last_error: null });
  });

  it("refuses another tenant's row before any service-role write", async () => {
    await expect(
      setCustomDomainVerifyState(asTenantId("tenant-a"), { p_id: "dom-b", p_status: "verifying", p_last_error: null }),
    ).rejects.toThrow(/does not belong/);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("refuses an unknown id before any service-role write", async () => {
    await expect(
      setCustomDomainVerifyState(asTenantId("tenant-a"), { p_id: "nope", p_status: "verified", p_last_error: null }),
    ).rejects.toThrow(/does not belong/);
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
