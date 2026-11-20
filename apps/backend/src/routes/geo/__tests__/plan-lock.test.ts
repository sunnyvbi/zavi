
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  openSweep: vi.fn(),
  ensureStarterPrompts: vi.fn(),
  suggestPrompts: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/supabase", () => ({ serverClientFromBearer: () => ({}), serviceClient: () => ({}) }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/tools/growth/geo/visibility/sweep", () => ({ openSweep: mocks.openSweep }));
vi.mock("@/services/tools/growth/geo/visibility/prompts", async (orig) => ({
  ...((await orig()) as object),
  ensureStarterPrompts: mocks.ensureStarterPrompts,
  suggestPrompts: mocks.suggestPrompts,
}));
vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig));

import { geoPromptStarter, geoPromptSuggest, geoSweepCreate } from "../index";
import { resetTenantPlan, tenantPlan } from "@/__tests__/helpers/tenant-plan";

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
const mkReq = (body: unknown = {}) => ({ body, query: {}, params: {} }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  resetTenantPlan();
  mocks.requireAuth.mockResolvedValue({ user_id: "u1", tenant_id: "t1", access_token: "tok" });
  mocks.openSweep.mockResolvedValue({ ok: true, sweep_id: "s1", planned: 4, country: "US" });
  mocks.ensureStarterPrompts.mockResolvedValue({ ok: true, state: "exists", accepted: 0 });
  mocks.suggestPrompts.mockResolvedValue({ ok: true, suggestions: [] });
});

describe("POST /api/geo/sweeps, the plan", () => {
  it("Free: 403 with the upgrade body and no sweep opened", async () => {
    tenantPlan.tier = "free";
    const res = mkRes();
    await geoSweepCreate(mkReq(), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("plan_upgrade_required");
    expect(mocks.openSweep).not.toHaveBeenCalled();
  });

  it("an unreadable plan refuses rather than sweeping", async () => {
    tenantPlan.unreadable = true;
    const res = mkRes();
    await geoSweepCreate(mkReq(), res);
    expect(res.statusCode).toBe(403);
    expect(mocks.openSweep).not.toHaveBeenCalled();
  });

  it("Starter: the sweep opens", async () => {
    tenantPlan.tier = "starter";
    const res = mkRes();
    await geoSweepCreate(mkReq(), res);
    expect(res.statusCode).toBe(202);
    expect(mocks.openSweep).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/geo/prompts/starter, the plan", () => {
  it("Free: 403 with the upgrade body and nothing seeded", async () => {
    tenantPlan.tier = "free";
    const res = mkRes();
    await geoPromptStarter(mkReq(), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("plan_upgrade_required");
    expect(mocks.ensureStarterPrompts).not.toHaveBeenCalled();
  });

  it("Starter: the seed runs", async () => {
    tenantPlan.tier = "starter";
    const res = mkRes();
    await geoPromptStarter(mkReq(), res);
    expect(res.statusCode).toBe(200);
    expect(mocks.ensureStarterPrompts).toHaveBeenCalledWith("t1");
  });
});

describe("POST /api/geo/prompts/suggest, the plan", () => {
  it("Free: 403 with the upgrade body and no model call", async () => {
    tenantPlan.tier = "free";
    const res = mkRes();
    await geoPromptSuggest(mkReq(), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("plan_upgrade_required");
    expect(mocks.suggestPrompts).not.toHaveBeenCalled();
  });

  it("Starter: suggestions are drafted", async () => {
    tenantPlan.tier = "starter";
    await geoPromptSuggest(mkReq(), mkRes());
    expect(mocks.suggestPrompts).toHaveBeenCalledWith("t1");
  });
});
