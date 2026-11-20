import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyBearer = vi.fn();
const cap = vi.fn();
vi.mock("@/services/auth/jwt", () => ({ verifyBearer: (...a: unknown[]) => verifyBearer(...a) }));
const beta = vi.fn();
vi.mock("@/services/auth/closedBetaGate", () => ({ requireClosedBetaGrant: (...a: unknown[]) => beta(...a) }));
vi.mock("@/services/tenants/tenant-create-guard", () => ({ checkSelfServeTenantCap: (...a: unknown[]) => cap(...a) }));

import { getCanAddCompany } from "../can-add-company";

function mockRes() {
  const res = { statusCode: 200, body: undefined as unknown };
  return Object.assign(res, {
    set() {
      return this;
    },
    status(c: number) {
      res.statusCode = c;
      return this;
    },
    json(b: unknown) {
      res.body = b;
      return this;
    },
  });
}

beforeEach(() => {
  verifyBearer.mockReset();
  cap.mockReset();
  beta.mockReset();
  beta.mockResolvedValue({ ok: true });
});

describe("GET /api/onboarding/can-add-company", () => {
  it("401s without a valid bearer", async () => {
    verifyBearer.mockResolvedValue(null);
    const res = mockRes();
    await getCanAddCompany({} as never, res as never);
    expect(res.statusCode).toBe(401);
  });

  it("mirrors the create guard for the caller", async () => {
    verifyBearer.mockResolvedValue({ user_id: "u1" });
    cap.mockResolvedValue({ code: "multi_workspace_not_enabled", message: "x" });
    const res = mockRes();
    await getCanAddCompany({} as never, res as never);
    expect(cap).toHaveBeenCalledWith("u1");
    expect(res.body).toEqual({ allowed: false, code: "multi_workspace_not_enabled" });

    cap.mockResolvedValue(null);
    await getCanAddCompany({} as never, res as never);
    expect(res.body).toEqual({ allowed: true, code: null });
  });

  it("refuses when the closed-beta gate would refuse the create", async () => {
    verifyBearer.mockResolvedValue({ user_id: "u1" });
    beta.mockResolvedValue({ ok: false, status: 403, code: "beta_not_granted", message: "x" });
    const res = mockRes();
    await getCanAddCompany({} as never, res as never);
    expect(res.body).toEqual({ allowed: false, code: "beta_not_granted" });
    expect(cap).not.toHaveBeenCalled();
  });
});
