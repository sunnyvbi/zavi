
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  refineProduct: vi.fn(),
  requestConductorTick: vi.fn(async (_client: unknown, _runId: string) => true),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));

vi.mock("@/services/agents/conductor-kick", () => ({
  requestConductorTick: mocks.requestConductorTick,
  requestTickForFinishedChild: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({ from: () => ({}) }),
  serviceClient: () => ({ from: () => ({}), rpc: vi.fn() }),
}));

vi.mock("@/agents/engineer/product-builder-flag", () => ({
  isProductBuilderEnabled: async () => true,
}));

vi.mock("@/services/agents/refine-product", async () => {
  const actual = await vi.importActual<typeof import("@/services/agents/refine-product")>(
    "@/services/agents/refine-product",
  );
  return { ...actual, refineProduct: mocks.refineProduct };
});

import { OldSiteFrozen } from "@/services/agents/refine-product";
import { postAutopilotRefineProduct } from "../autopilot";

function mockRes() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
  } = {
    statusCode: 200,
    body: undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

const BUILD_A = "11111111-1111-4111-8111-111111111111";
const BUILD_B = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.refineProduct.mockReset();
  mocks.requestConductorTick.mockClear();
  mocks.requireAuth.mockResolvedValue({
    tenant_id: "tnt-1",
    user_id: "user-1",
    access_token: "tok",
  });
});

describe("POST /refine-product — an old-flow Build Session is frozen (2026-10-02)", () => {
  it("409s with the typed freeze reply and the Rebuild action", async () => {
    mocks.refineProduct.mockRejectedValueOnce(new OldSiteFrozen("tnt-1"));
    const res = mockRes();
    await postAutopilotRefineProduct(
      { body: { message: "make the header sticky", conductor_run_id: BUILD_A } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(409);
    const body = res.body as { error: { code: string; message: string; action: { kind: string; label: string } } };
    expect(body.error.code).toBe("old_site_frozen");
    expect(body.error.message).toMatch(/earlier builder/);
    expect(body.error.message).toMatch(/does not move over/);
    expect(body.error.action).toEqual({ kind: "rebuild_old_site", label: "Rebuild on the new builder" });
    expect(mocks.refineProduct).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: "tnt-1", conductor_run_id: BUILD_A }),
    );
  });
});

describe("POST /refine-product — the conductor is ticked immediately", () => {
  it("ticks the new conductor run rather than leaving it for the cron", async () => {
    mocks.refineProduct.mockResolvedValueOnce({
      conductor_run_id: BUILD_B,
      parent_conductor_run_id: BUILD_A,
      target: "repo",
    });
    const res = mockRes();
    await postAutopilotRefineProduct(
      { body: { message: "make the header sticky", conductor_run_id: BUILD_A } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(mocks.requestConductorTick).toHaveBeenCalledOnce();
    expect(mocks.requestConductorTick).toHaveBeenCalledWith(expect.anything(), BUILD_B);
  });
});
