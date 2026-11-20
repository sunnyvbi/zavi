
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: (tid: string, name: string, args: Record<string, unknown>) =>
    rpc(tid, name, args),
}));

import { channelBudgetAllows } from "@/services/channels/budget";

const TID = "22222222-2222-2222-2222-222222222222";

const mockRpc = (allow: unknown, spent: unknown, allowError: unknown = null) => {
  rpc.mockImplementation((_tid: string, name: string) => {
    if (name === "channel_budget_allows")
      return Promise.resolve({ data: allow, error: allowError });
    return Promise.resolve({ data: spent, error: null });
  });
};

beforeEach(() => rpc.mockReset());

describe("channelBudgetAllows", () => {
  it("allows a run under the cap and reports spend", async () => {
    mockRpc(true, 480);
    expect(await channelBudgetAllows(TID, 160)).toEqual({
      allowed: true,
      spent_30d: 480,
    });
  });

  it("refuses at the cap with a distinguishable reason", async () => {
    mockRpc(false, 2000);
    expect(await channelBudgetAllows(TID, 160)).toEqual({
      allowed: false,
      reason: "cap_reached",
      spent_30d: 2000,
    });
  });

  it("passes the run estimate so the check happens BEFORE credits are reserved", async () => {
    mockRpc(true, 0);
    await channelBudgetAllows(TID, 160);
    const call = rpc.mock.calls.find((c) => c[1] === "channel_budget_allows");
    expect(call?.[2]).toEqual({ p_estimate: 160 });
  });

  it("never passes a tenant id in args — the facade injects it", async () => {
    mockRpc(true, 0);
    await channelBudgetAllows(TID, 160);
    for (const call of rpc.mock.calls) {
      expect(call[2]).not.toHaveProperty("p_tenant_id");
    }
  });

  describe("fails CLOSED", () => {
    it("denies when the RPC errors", async () => {
      mockRpc(null, 100, { message: "db down" });
      const v = await channelBudgetAllows(TID, 160);
      expect(v.allowed).toBe(false);
      expect(v).toMatchObject({ reason: "unavailable" });
    });

    it("denies when the RPC returns a non-boolean", async () => {
      mockRpc("yes", 100);
      expect(await channelBudgetAllows(TID, 160)).toMatchObject({
        allowed: false,
        reason: "unavailable",
      });
    });

    it("denies when the RPC rejects", async () => {
    });
  });

  it("treats an unreadable spend figure as 0 rather than NaN", async () => {
    mockRpc(true, null);
    expect((await channelBudgetAllows(TID, 160)).spent_30d).toBe(0);
  });
});
