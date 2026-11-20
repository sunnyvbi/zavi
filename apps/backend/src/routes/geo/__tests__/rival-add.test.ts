
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  role: { value: "owner" as string | null },
  competitors: { value: ["Acme"] as string[] },
  setCompanyFact: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/supabase", () => {
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: mocks.role.value ? { role: mocks.role.value } : null, error: null }) };
  return { serverClientFromBearer: () => ({ from: () => q }), serviceClient: () => ({}) };
});
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/company/facts", () => ({
  getCompanyFacts: async () => ({ name: "Shop", website: "https://shop.example", competitors: mocks.competitors.value }),
  setCompanyFact: (...a: unknown[]) => mocks.setCompanyFact(...a),
  joinCompetitors: (names: string[]) => names.join(", "),
}));

import { geoRivalAdd } from "../index";

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
const mkReq = (body: unknown) => ({ body, query: {}, params: {} }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role.value = "owner";
  mocks.competitors.value = ["Acme"];
  mocks.requireAuth.mockResolvedValue({ user_id: "u1", tenant_id: "t1", access_token: "tok" });
  mocks.setCompanyFact.mockImplementation(async (_t: string, _k: string, v: string) => {
    mocks.competitors.value = v.split(", ");
    return { ok: true };
  });
});

describe("POST /api/geo/rivals", () => {
  it("adds the name to the existing list and says the baseline reset", async () => {
    const res = mkRes();
    await geoRivalAdd(mkReq({ name: " Globex " }), res);
    expect(res.statusCode).toBe(200);
    expect(mocks.setCompanyFact).toHaveBeenCalledWith("t1", "competitors", "Acme, Globex", expect.any(String));
    expect(res.body).toMatchObject({ rivals: ["Acme", "Globex"], baseline_reset: true });
  });

  it("a name already on the list changes nothing and does not reset the baseline", async () => {
    const res = mkRes();
    await geoRivalAdd(mkReq({ name: "acme" }), res);
    expect(res.body).toMatchObject({ rivals: ["Acme"], baseline_reset: false });
  });

  it("a member cannot add one", async () => {
    mocks.role.value = "member";
    const res = mkRes();
    await geoRivalAdd(mkReq({ name: "Globex" }), res);
    expect(res.statusCode).toBe(403);
    expect(mocks.setCompanyFact).not.toHaveBeenCalled();
  });

  it("an empty name is refused", async () => {
    const res = mkRes();
    await geoRivalAdd(mkReq({ name: "  " }), res);
    expect(res.statusCode).toBe(400);
    expect(mocks.setCompanyFact).not.toHaveBeenCalled();
  });
});
