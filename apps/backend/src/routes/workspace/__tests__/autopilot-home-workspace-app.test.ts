
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  refineProduct: vi.fn(),
  refineUndo: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { role: "owner" }, error: null }) };
      return b;
    },
    rpc: vi.fn(),
  }),
  serverClientFromBearer: () => ({}),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
vi.mock("@/services/agents/conductor-kick", () => ({
  requestConductorTick: vi.fn(async () => true),
  requestTickForFinishedChild: vi.fn(),
}));
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: async () => true }));
vi.mock("@/services/settings", async () => {
  const actual = await vi.importActual<typeof import("@/services/settings")>("@/services/settings");
  return { ...actual, getBoolSetting: vi.fn(async () => false) };
});
vi.mock("@/services/agents/refine-product", async () => {
  const actual = await vi.importActual<typeof import("@/services/agents/refine-product")>("@/services/agents/refine-product");
  return { ...actual, refineProduct: mocks.refineProduct };
});
vi.mock("@/services/agents/refine-undo", async () => {
  const actual = await vi.importActual<typeof import("@/services/agents/refine-undo")>("@/services/agents/refine-undo");
  return { ...actual, refineUndo: mocks.refineUndo };
});

import { postAutopilotRefineProduct, postAutopilotRefineUndo } from "../autopilot";
import { NoUndoableRefine } from "@/services/agents/refine-undo";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { res.statusCode = c; return res; },
    json(b: unknown) { res.body = b; return res; },
  };
  return res;
}

beforeEach(() => {
  mocks.requireAuth.mockReset().mockResolvedValue({ tenant_id: "tnt-1", user_id: "u1", access_token: "tok" });
  mocks.refineProduct.mockReset().mockResolvedValue({ conductor_run_id: "cr-new", parent_conductor_run_id: null, target: "repo" });
  mocks.refineUndo.mockReset();
});

const MSG = "make the header sticky on every page";

describe("POST /refine-product app=workspace", () => {
  it("pins Home's edit to the workspace app (singleton_app), never an unbound site pick", async () => {
    const res = mockRes();
    await postAutopilotRefineProduct({ body: { message: MSG, app: "workspace" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(mocks.refineProduct.mock.calls[0][0]).toMatchObject({ tenant_id: "tnt-1", singleton_app: true, conductor_run_id: null });
  });

  it("a refine without app keeps the unbound behaviour", async () => {
    await postAutopilotRefineProduct({ body: { message: MSG } } as never, mockRes() as never);
    expect(mocks.refineProduct.mock.calls[0][0]).not.toHaveProperty("singleton_app");
  });

  it("refuses an unknown app, and app=workspace with a session", async () => {
    for (const body of [{ message: MSG, app: "site" }, { message: MSG, app: "workspace", conductor_run_id: "11111111-1111-4111-8111-111111111111" }]) {
      const res = mockRes();
      await postAutopilotRefineProduct({ body } as never, res as never);
      expect(res.statusCode).toBe(400);
    }
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });
});

describe("POST /refine-undo app=workspace", () => {
  it("passes workspace_only, and a refused site edit is a 404 no_undoable_refine", async () => {
    mocks.refineUndo.mockRejectedValue(new NoUndoableRefine("tnt-1"));
    const res = mockRes();
    await postAutopilotRefineUndo({ body: { conductor_run_id: "edit-site-a", app: "workspace" }, query: {} } as never, res as never);
    expect(mocks.refineUndo.mock.calls[0][0]).toMatchObject({ tenant_id: "tnt-1", conductor_run_id: "edit-site-a", workspace_only: true });
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "no_undoable_refine" } });
  });

  it("a build-session undo (no app) is unscoped, and an unknown app is refused", async () => {
    mocks.refineUndo.mockResolvedValue({ undo_conductor_run_id: "u", reverted_conductor_run_id: "e", reverted_commit_sha: "a", new_commit_sha: "b", branch: "main" });
    await postAutopilotRefineUndo({ body: { conductor_run_id: "e" }, query: {} } as never, mockRes() as never);
    expect(mocks.refineUndo.mock.calls[0][0]).not.toHaveProperty("workspace_only");
    const res = mockRes();
    await postAutopilotRefineUndo({ body: { conductor_run_id: "e", app: "site" }, query: {} } as never, res as never);
    expect(res.statusCode).toBe(400);
    expect(mocks.refineUndo).toHaveBeenCalledTimes(1);
  });
});
