import { beforeEach, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { BUSINESS_CONTROL_DEFAULTS as policy } from "@/services/growth/business-control-policy";
import { putGrowthControls, postGrowthExperiment } from "../growth-controls";
let auth: any, role: string, tier: string;
const rpc = vi.fn(),
  register = vi.fn();
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (_r: any, res: any) => {
    if (!auth) res.status(401).json({});
    return auth;
  },
}));
vi.mock("@/services/auth/tenant-role", () => ({
  loadTenantRole: async () => role,
  requireTenantRole: async (_a: any, allowed: string[], res: any) => {
    if (allowed.includes(role)) return true;
    res.status(403).json({});
    return false;
  },
}));
vi.mock("@/services/agents/entitlement", () => ({
  loadTierGateConfig: async () => ({}),
  resolveTenantTier: async () => tier,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: (...a: unknown[]) => rpc(...a),
}));
vi.mock("@/services/growth/experiment-controls", () => ({
  registerExperiment: (...a: unknown[]) => register(...a),
}));
function res() {
  const r: any = { statusCode: 200 };
  r.status = (c: number) => ((r.statusCode = c), r);
  r.json = (b: any) => ((r.body = b), r);
  return r as Response & { statusCode: number; body: any };
}
const req = (body: unknown) => ({ body }) as Request;
beforeEach(() => {
  auth = { user_id: "owner", tenant_id: "session-tenant" };
  role = "owner";
  tier = "pro";
  rpc
    .mockReset()
    .mockResolvedValue({ data: { status: "saved", revision: 2 }, error: null });
  register.mockReset().mockResolvedValue("exp");
});
it.each(["member", "viewer"])("refuses %s writes", async (r) => {
  role = r;
  const response = res();
  await putGrowthControls(req({ policy, revision: 1 }), response);
  expect(response.statusCode).toBe(403);
  expect(rpc).not.toHaveBeenCalled();
});
it("refuses eval tenant overrides", async () => {
  auth.tenant_overridden = true;
  const r = res();
  await putGrowthControls(req({ policy, revision: 1 }), r);
  expect(r.statusCode).toBe(403);
  expect(rpc).not.toHaveBeenCalled();
});
it("requires Pro to enable, while allowing revocation on any plan", async () => {
  tier = "free";
  const r = res();
  await putGrowthControls(
    req({ policy: { ...policy, enabled: true }, revision: 1 }),
    r,
  );
  expect(r.statusCode).toBe(403);
  await putGrowthControls(req({ policy, revision: 1 }), res());
  expect(rpc).toHaveBeenCalledOnce();
});
it("uses only the session tenant and owner for saving", async () => {
  await putGrowthControls(req({ policy, revision: 1 }), res());
  expect(rpc).toHaveBeenCalledWith(
    "session-tenant",
    "save_growth_business_policy",
    { p_actor: "owner", p_policy: policy, p_revision: 1 },
  );
});
it("refuses tenant injection and server metadata in strict inputs", async () => {
  for (const body of [
    { policy, revision: 1, tenant_id: "other" },
    { policy: { ...policy, updated_at: "forged" }, revision: 1 },
  ]) {
    const r = res();
    await putGrowthControls(req(body), r);
    expect(r.statusCode).toBe(400);
  }
  expect(rpc).not.toHaveBeenCalled();
});
it("returns a conflict instead of silently overwriting newer settings", async () => {
  rpc.mockResolvedValue({ data: { status: "conflict" }, error: null });
  const r = res();
  await putGrowthControls(req({ policy, revision: 1 }), r);
  expect(r.statusCode).toBe(409);
});
it("requires the same owner and Pro authority to register tests", async () => {
  role = "member";
  let r = res();
  await postGrowthExperiment(req({}), r);
  expect(r.statusCode).toBe(403);
  role = "owner";
  r = res();
  await postGrowthExperiment(req({ name: "test" }), r);
  expect(r.statusCode).toBe(201);
  expect(register).toHaveBeenCalledWith("session-tenant", "owner", {
    name: "test",
  });
});
