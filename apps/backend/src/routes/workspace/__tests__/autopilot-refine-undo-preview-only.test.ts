import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  refineUndo: vi.fn(),
  undoKey: true as boolean,
}));

type RoleQuery = { select: () => RoleQuery; eq: () => RoleQuery; maybeSingle: () => Promise<{ data: { role: string }; error: null }> };

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const b: RoleQuery = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { role: "owner" }, error: null }) };
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
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  await postAutopilotRefineUndo({ body: { conductor_run_id: "edit-a" }, query: {} } as never, res as never);
  return res as { statusCode: number; body: Record<string, unknown> };
}

beforeEach(() => {
  mocks.undoKey = true;
  mocks.requireAuth.mockReset().mockResolvedValue({ tenant_id: "tnt-1", user_id: "u-owner", access_token: "tok" });
  mocks.refineUndo.mockReset();
});

describe("undo route: an undo that stopped at the preview", () => {
  it("an undo on a never-published site reports preview_only:true with republished:false", async () => {
    mocks.refineUndo.mockResolvedValue({ ...LANDED, republished: false, history_recorded: true, draft_reset: true, preview_only: true });
    const r = await undo();
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      ...LANDED,
      republished: false,
      republish_pending: false,
      history_recorded: true,
      draft_reset: true,
      preview_only: true,
    });
  });

  it("with the undo key off it is still passed through", async () => {
    mocks.undoKey = false;
    mocks.refineUndo.mockResolvedValue({ ...LANDED, republished: false, history_recorded: true, draft_reset: true, preview_only: true });
    expect((await undo()).body).toMatchObject({ republished: false, preview_only: true });
  });

  it("an ordinary undo that republished has no preview_only key at all", async () => {
    mocks.refineUndo.mockResolvedValue({ ...LANDED, republished: true, history_recorded: true, draft_reset: true });
    const r = await undo();
    expect(r.body).toEqual({ ok: true, ...LANDED, republish_pending: false, republished: true, history_recorded: true, draft_reset: true });
    expect("preview_only" in r.body).toBe(false);
  });

  it("a live-site undo whose republish did not start is not mistaken for a preview-only undo", async () => {
    mocks.refineUndo.mockResolvedValue({ ...LANDED, republished: false, history_recorded: true, draft_reset: true });
    const r = await undo();
    expect(r.body.republished).toBe(false);
    expect("preview_only" in r.body).toBe(false);
  });

  it.each([false, "true", 1, null, undefined])("a preview_only of %j from the service is never reported", async (value) => {
    mocks.refineUndo.mockResolvedValue({ ...LANDED, republished: false, history_recorded: true, draft_reset: true, preview_only: value });
    expect("preview_only" in (await undo()).body).toBe(false);
  });

  it("the old unguarded path with no outcomes reports neither outcomes nor preview_only", async () => {
    mocks.undoKey = false;
    mocks.refineUndo.mockResolvedValue({ ...LANDED });
    expect((await undo()).body).toEqual({ ok: true, ...LANDED });
  });

  it("an undo whose preview could not be moved to the revert reports preview_stale:true beside preview_only", async () => {
    mocks.refineUndo.mockResolvedValue({ ...LANDED, republished: false, history_recorded: true, draft_reset: true, preview_only: true, preview_stale: true });
    const r = await undo();
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      ...LANDED,
      republished: false,
      republish_pending: false,
      history_recorded: true,
      draft_reset: true,
      preview_only: true,
      preview_stale: true,
    });
  });

  it("preview_stale is passed through with the undo key off too", async () => {
    mocks.undoKey = false;
    mocks.refineUndo.mockResolvedValue({ ...LANDED, republished: false, history_recorded: true, draft_reset: true, preview_only: true, preview_stale: true });
    expect((await undo()).body).toMatchObject({ preview_only: true, preview_stale: true });
  });

  it("an undo whose preview did move has no preview_stale key", async () => {
    mocks.refineUndo.mockResolvedValue({ ...LANDED, republished: false, history_recorded: true, draft_reset: true, preview_only: true });
    const r = await undo();
    expect(r.body.preview_only).toBe(true);
    expect("preview_stale" in r.body).toBe(false);
  });

  it("an ordinary republished undo has no preview_stale key", async () => {
    mocks.refineUndo.mockResolvedValue({ ...LANDED, republished: true, history_recorded: true, draft_reset: true });
    expect("preview_stale" in (await undo()).body).toBe(false);
  });

  it.each([false, "true", 1, null, undefined])("a preview_stale of %j from the service is never reported", async (value) => {
    mocks.refineUndo.mockResolvedValue({ ...LANDED, republished: false, history_recorded: true, draft_reset: true, preview_only: true, preview_stale: value });
    const r = await undo();
    expect("preview_stale" in r.body).toBe(false);
    expect(r.body.preview_only).toBe(true);
  });
});
