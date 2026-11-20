import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  checkAgentTier: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/agents/entitlement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/agents/entitlement")>();
  return { ...actual, checkAgentTier: mocks.checkAgentTier };
});

import { proPageGate } from "../pro-page-gate";

const mkRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};
const mkReq = () => ({ body: {}, query: {}, params: {} }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ user_id: "u1", tenant_id: "t1", access_token: "tok" });
  mocks.checkAgentTier.mockResolvedValue({ enforced: true, tier: "pro", required_tier: "pro", allowed: true });
});

describe("proPageGate", () => {
  it("stops at auth without reading the tier", async () => {
    mocks.requireAuth.mockResolvedValue(null);
    const next = vi.fn();
    await proPageGate("fundraising")(mkReq(), mkRes(), next);
    expect(next).not.toHaveBeenCalled();
    expect(mocks.checkAgentTier).not.toHaveBeenCalled();
  });

  it("passes a Pro tenant through, checked against the caller's tenant", async () => {
    const next = vi.fn();
    await proPageGate("fundraising")(mkReq(), mkRes(), next);
    expect(mocks.checkAgentTier).toHaveBeenCalledWith("t1", "fundraising");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("refuses below Pro with the standard upgrade body", async () => {
    mocks.checkAgentTier.mockResolvedValue({ enforced: true, tier: "growth", required_tier: "pro", allowed: false });
    const next = vi.fn();
    const res = mkRes();
    await proPageGate("supply-demand-balancer")(mkReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: {
        code: "plan_upgrade_required",
        required_tier: "pro",
        message: "Supply Demand Balancer needs the Pro plan ($240/mo).",
      },
    });
  });

  it("fails closed with 503 when the tier cannot be read", async () => {
    mocks.checkAgentTier.mockRejectedValue(new Error("db down"));
    const next = vi.fn();
    const res = mkRes();
    await proPageGate("fundraising")(mkReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "plan_check_unavailable" } });
  });
});
