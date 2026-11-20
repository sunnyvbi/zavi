import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  refineProduct: vi.fn(),
  requestConductorTick: vi.fn(async (_client: unknown, _runId: string) => true),
}));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => {
    throw new Error("a plain refine must not read the database in the route");
  },
  serviceClient: () => ({ from: () => ({}), rpc: vi.fn() }),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
vi.mock("@/services/agents/conductor-kick", () => ({
  requestConductorTick: mocks.requestConductorTick,
  requestTickForFinishedChild: vi.fn(),
}));
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: async () => true }));
vi.mock("@/services/agents/refine-product", async () => {
  const actual = await vi.importActual<typeof import("@/services/agents/refine-product")>(
    "@/services/agents/refine-product",
  );
  return { ...actual, refineProduct: mocks.refineProduct };
});

import { postAutopilotRefineProduct } from "../autopilot";

const SESSION = "11111111-1111-4111-8111-111111111111";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

async function post(body: Record<string, unknown>) {
  const res = mockRes();
  await postAutopilotRefineProduct({ body } as never, res as never);
  return res;
}

beforeEach(() => {
  mocks.requireAuth.mockReset().mockResolvedValue({ tenant_id: "tnt-1", user_id: "u1", access_token: "tok" });
  mocks.requestConductorTick.mockClear();
  mocks.refineProduct.mockReset().mockResolvedValue({
    conductor_run_id: "cr-new",
    parent_conductor_run_id: SESSION,
    target: "repo",
  });
});

describe("POST /refine-product small_edit", () => {
  it("hands small_edit=true to refineProduct when the client flags a small edit", async () => {
    const res = await post({ message: "change the hero title to Rent bikes fast", conductor_run_id: SESSION, small_edit: true });
    expect(res.statusCode).toBe(200);
    expect(mocks.refineProduct).toHaveBeenCalledTimes(1);
    expect(mocks.refineProduct.mock.calls[0][0]).toMatchObject({ small_edit: true, conductor_run_id: SESSION, tenant_id: "tnt-1" });
  });

  it("ignores a client small_edit flag on a structural change so a big change cannot buy the cheaper lane", async () => {
    await post({ message: "add a new pricing section with three plans and a signup flow", conductor_run_id: SESSION, small_edit: true });
    expect(mocks.refineProduct.mock.calls[0][0]).not.toHaveProperty("small_edit");
  });

  it("omits the flag for an ordinary refine", async () => {
    await post({ message: "add a pricing section with three plans", conductor_run_id: SESSION });
    expect(mocks.refineProduct.mock.calls[0][0]).not.toHaveProperty("small_edit");
  });

  it.each([["true"], [1], [{}], [null], [false]])("never treats a non-boolean-true small_edit (%j) as a small edit", async (value) => {
    await post({ message: "change the hero title to Rent bikes fast", conductor_run_id: SESSION, small_edit: value });
    expect(mocks.refineProduct.mock.calls[0][0]).not.toHaveProperty("small_edit");
  });

  it("rejects a too-short small edit before anything is enqueued", async () => {
    const res = await post({ message: "hi", small_edit: true });
    expect(res.statusCode).toBe(400);
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });
});
