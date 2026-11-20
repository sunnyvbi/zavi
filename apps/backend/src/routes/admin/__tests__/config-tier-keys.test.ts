import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ upsert: null as any, rpc: null as any }));

vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: () => ({ user_id: "u1", email: "staff@example.com" }),
}));
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: vi.fn(async () => undefined) }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    const q: any = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: { blob: {} }, error: null }),
      upsert: (...a: unknown[]) => H.upsert(...a),
    };
    return { from: () => q, rpc: (...a: unknown[]) => H.rpc(...a) };
  },
}));

import { staffConfigPatch } from "../config";

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

async function patch(p: Record<string, unknown>) {
  const res = makeRes();
  await staffConfigPatch({ body: { patch: p } } as any, res as any);
  return res;
}

describe("staffConfigPatch tier keys", () => {
  beforeEach(() => {
    H.upsert = vi.fn(async () => ({ error: null }));
    H.rpc = vi.fn(async () => ({ data: [], error: null }));
  });

  it.each([
    [{ tier_credits: { starter: -5 } }, "invalid_tier_credits"],
    [{ tier_credits: { enterprise: 5 } }, "invalid_tier_credits"],
    [{ tier_agent_min: { engineer: "gold" } }, "invalid_tier_agent_min"],
    [{ tier_gate_enforced: "yes" }, "invalid_tier_gate_enforced"],
    [{ tier_pro_tenants: ["not-a-uuid"] }, "invalid_tier_pro_tenants"],
    [{ free_daily_credits: "1,000" }, "invalid_free_daily_credits"],
    [{ free_daily_credits: "1000" }, "invalid_free_daily_credits"],
    [{ free_daily_credits: 1000.5 }, "invalid_free_daily_credits"],
    [{ free_daily_credits: 0 }, "invalid_free_daily_credits"],
    [{ free_daily_credits: -5 }, "invalid_free_daily_credits"],
    [{ free_daily_credits: null }, "invalid_free_daily_credits"],
  ])("rejects %j with %s and does not write", async (p, code) => {
    const res = await patch(p);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(typeof res.body.error.message).toBe("string");
    expect(H.upsert).not.toHaveBeenCalled();
  });

  it("accepts valid tier keys and writes them", async () => {
    const res = await patch({
      tier_credits: { starter: 8000, growth: 48000, pro: 96000 },
      tier_agent_min: { engineer: "pro" },
      tier_gate_enforced: false,
      tier_pro_tenants: ["73db45ff-457e-4541-bc8f-bdb625390204"],
      free_daily_credits: 1000,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(H.upsert).toHaveBeenCalledTimes(1);
  });
});
