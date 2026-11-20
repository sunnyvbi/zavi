
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  refineUndo: vi.fn(),
  undoKey: true as boolean,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { role: "owner" }, error: null }) };
      return b;
    },
  }),
  serverClientFromBearer: () => ({}),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/settings", async () => {
  const actual = await vi.importActual<typeof import("@/services/settings")>("@/services/settings");
  return { ...actual, getBoolSetting: vi.fn(async (key: string) => (key === "build_edit_undo" ? mocks.undoKey : false)) };
});
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: async () => true }));
vi.mock("@/services/agents/refine-undo", async () => {
  const actual = await vi.importActual<typeof import("@/services/agents/refine-undo")>("@/services/agents/refine-undo");
  return { ...actual, refineUndo: mocks.refineUndo };
});

import { postAutopilotRefineUndo } from "../autopilot";

const LANDED = {
  undo_conductor_run_id: "undo-1",
  reverted_conductor_run_id: "edit-a",
  reverted_commit_sha: "a".repeat(40),
  new_commit_sha: "b".repeat(40),
  branch: "main",
};

async function undo() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { res.statusCode = c; return res; },
    json(b: unknown) { res.body = b; return res; },
  };
  await postAutopilotRefineUndo({ body: { conductor_run_id: "edit-a" }, query: {} } as never, res as never);
  return res;
}

beforeEach(() => {
  mocks.undoKey = true;
  mocks.requireAuth.mockReset().mockResolvedValue({ tenant_id: "tnt-1", user_id: "u-owner", access_token: "tok" });
  mocks.refineUndo.mockReset();
});

describe("undo route outcomes", () => {
  it("a site undo that did not republish reports republished:false", async () => {
    mocks.refineUndo.mockResolvedValue({ ...LANDED, republished: false, history_recorded: true, draft_reset: true });
    expect((await undo()).body).toMatchObject({ ok: true, republished: false, republish_pending: false, history_recorded: true, draft_reset: true });
    mocks.refineUndo.mockResolvedValue({ ...LANDED, republished: false, republish_pending: true, history_recorded: true, draft_reset: true });
    expect((await undo()).body).toMatchObject({ ok: true, republished: false, republish_pending: true });
  });

  it("a guarded result with a missing outcome reports it as false, never true", async () => {
    mocks.refineUndo.mockResolvedValue({ ...LANDED, republished: true });
    expect((await undo()).body).toMatchObject({ republished: true, history_recorded: false, draft_reset: false });
  });

  it("with the undo key off, a site undo still reports its explicit outcomes", async () => {
    mocks.undoKey = false;
    mocks.refineUndo.mockResolvedValue({ ...LANDED, republished: false, history_recorded: false, draft_reset: true });
    expect((await undo()).body).toMatchObject({ republished: false, history_recorded: false, draft_reset: true });
  });
});
