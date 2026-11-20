import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  refineUndo: vi.fn(),
  refineRestore: vi.fn(),
  roleReadError: null as string | null,
  undoKey: true as boolean,
  memberships: [] as Array<{ user_id: string; tenant_id: string; role: string }>,
  roleReads: [] as Array<Record<string, unknown>>,
}));

function roleClient() {
  const filters: Record<string, unknown> = {};
  const b = {
    select: () => b,
    eq: (k: string, v: unknown) => {
      filters[k] = v;
      return b;
    },
    maybeSingle: async () => {
      mocks.roleReads.push({ ...filters });
      if (mocks.roleReadError) return { data: null, error: { message: mocks.roleReadError } };
      const hit = mocks.memberships.find((m) => m.user_id === filters.user_id && m.tenant_id === filters.tenant_id);
      return { data: hit ? { role: hit.role } : null, error: null };
    },
  };
  return b;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "tenant_users") return roleClient();
      throw new Error(`unexpected table ${table}`);
    },
  }),
  serverClientFromBearer: () => ({}),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/settings", async () => {
  const actual = await vi.importActual<typeof import("@/services/settings")>("@/services/settings");
  return {
    ...actual,
    getBoolSetting: vi.fn(async (key: string) => (key === "build_edit_undo" ? mocks.undoKey : false)),
  };
});
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: async () => true }));
vi.mock("@/services/agents/refine-undo", async () => {
  const actual = await vi.importActual<typeof import("@/services/agents/refine-undo")>("@/services/agents/refine-undo");
  return { ...actual, refineUndo: mocks.refineUndo, refineRestore: mocks.refineRestore };
});

import { postAutopilotRefineUndo, postAutopilotRestoreCheckpoint } from "../autopilot";
import { UndoBlocked, UndoCommitNotFound, NoUndoableRefine } from "@/services/agents/refine-undo";

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

async function undo(body: Record<string, unknown> = { conductor_run_id: "edit-colour" }) {
  const res = mockRes();
  await postAutopilotRefineUndo({ body, query: {} } as never, res as never);
  return res;
}

const LANDED = {
  undo_conductor_run_id: "undo-1",
  reverted_conductor_run_id: "edit-colour",
  reverted_commit_sha: "a".repeat(40),
  new_commit_sha: "b".repeat(40),
  branch: "main",
};

beforeEach(() => {
  mocks.undoKey = true;
  mocks.roleReadError = null;
  mocks.refineRestore.mockReset().mockResolvedValue({ restored: true });
  mocks.roleReads.length = 0;
  mocks.memberships = [
    { user_id: "u-member", tenant_id: "tnt-yoga", role: "member" },
    { user_id: "u-member", tenant_id: "tnt-own", role: "owner" },
    { user_id: "u-owner", tenant_id: "tnt-yoga", role: "owner" },
    { user_id: "u-admin", tenant_id: "tnt-yoga", role: "admin" },
    { user_id: "u-viewer", tenant_id: "tnt-yoga", role: "viewer" },
    { user_id: "u-viewer", tenant_id: "tnt-own", role: "owner" },
  ];
  mocks.requireAuth.mockReset().mockResolvedValue({ tenant_id: "tnt-yoga", user_id: "u-member", access_token: "tok" });
  mocks.refineUndo.mockReset().mockResolvedValue({ ...LANDED, republished: true, history_recorded: true, draft_reset: true });
});

describe("DEL-1323 B29 H2 + option C (Ravi 2026-10-02): undo is for owners, admins and members, never viewers", () => {
  it("a viewer of this workspace is refused before any revert, even though they own another workspace", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-yoga", user_id: "u-viewer", access_token: "tok" });
    const res = await undo();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("forbidden");
    expect(mocks.roleReads).toEqual([{ user_id: "u-viewer", tenant_id: "tnt-yoga" }]);
    expect(mocks.refineUndo).not.toHaveBeenCalled();
  });

  it("a caller with no membership row is refused", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-yoga", user_id: "u-gone", access_token: "tok" });
    const res = await undo();
    expect(res.statusCode).toBe(403);
    expect(mocks.refineUndo).not.toHaveBeenCalled();
  });

  it.each(["u-owner", "u-admin", "u-member"])("%s reaches the guarded undo, scoped to their own tenant", async (user) => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-yoga", user_id: user, access_token: "tok" });
    const res = await undo();
    expect(res.statusCode).toBe(200);
    expect(mocks.refineUndo).toHaveBeenCalledWith({ tenant_id: "tnt-yoga", conductor_run_id: "edit-colour", guarded: true });
  });

  it("key off: a viewer is still refused, the role gate does not ride the key", async () => {
    mocks.undoKey = false;
    mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-yoga", user_id: "u-viewer", access_token: "tok" });
    const res = await undo();
    expect(res.statusCode).toBe(403);
    expect(mocks.roleReads).toEqual([{ user_id: "u-viewer", tenant_id: "tnt-yoga" }]);
    expect(mocks.refineUndo).not.toHaveBeenCalled();
  });

  it("key off: an owner gets the unguarded path and the old response, as before", async () => {
    mocks.undoKey = false;
    mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-yoga", user_id: "u-owner", access_token: "tok" });
    mocks.refineUndo.mockResolvedValue(LANDED);
    const res = await undo();
    expect(res.statusCode).toBe(200);
    expect(mocks.refineUndo).toHaveBeenCalledWith({ tenant_id: "tnt-yoga", conductor_run_id: "edit-colour", guarded: false });
    expect(res.body).toEqual({ ok: true, ...LANDED });
  });
});

describe("DEL-1323 B29 M1-M3: refusals and outcomes reach the client with distinct codes", () => {
  beforeEach(() => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-yoga", user_id: "u-owner", access_token: "tok" });
  });

  it.each([
    ["build_in_progress"],
    ["newer_change"],
    ["unpublished_draft"],
    ["undo_in_progress"],
  ] as const)("%s is a 409 with that code", async (reason) => {
    mocks.refineUndo.mockRejectedValue(new UndoBlocked(reason, "blocked"));
    const res = await undo();
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe(reason);
  });

  it("an unresolvable commit is undo_commit_not_found, not no_undoable_refine", async () => {
    mocks.refineUndo.mockRejectedValue(new UndoCommitNotFound());
    const res = await undo();
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe("undo_commit_not_found");
  });

  it("no_undoable_refine keeps its 404", async () => {
    mocks.refineUndo.mockRejectedValue(new NoUndoableRefine("tnt-yoga"));
    const res = await undo();
    expect(res.statusCode).toBe(404);
  });

  it("a revert that landed but did not republish or reset the preview says so", async () => {
    mocks.refineUndo.mockResolvedValue({ ...LANDED, republished: false, history_recorded: false, draft_reset: false });
    const res = await undo();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, republished: false, history_recorded: false, draft_reset: false });
  });
});

describe("DEL-1323 B29 review: role gate failures and restore", () => {
  it("an unreadable role answers 500 JSON instead of hanging, and nothing is undone", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-yoga", user_id: "u-owner", access_token: "tok" });
    mocks.roleReadError = "connection reset";
    const res = mockRes();
    await expect(postAutopilotRefineUndo({ body: { conductor_run_id: "edit-colour" }, query: {} } as never, res as never)).resolves.toBeUndefined();
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe("role_check_failed");
    expect(mocks.refineUndo).not.toHaveBeenCalled();
  });

  async function restore() {
    const res = mockRes();
    await postAutopilotRestoreCheckpoint({ body: { conductor_run_id: "edit-colour" }, query: {} } as never, res as never);
    return res;
  }

  it("a plain member cannot roll the live site back to a checkpoint", async () => {
    const res = await restore();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("forbidden");
    expect(mocks.refineRestore).not.toHaveBeenCalled();
  });

  it("an unreadable role refuses the restore with 500 JSON and restores nothing", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-yoga", user_id: "u-owner", access_token: "tok" });
    mocks.roleReadError = "connection reset";
    const res = await restore();
    expect(res.statusCode).toBe(500);
    expect(mocks.refineRestore).not.toHaveBeenCalled();
  });

  it.each(["u-owner", "u-admin"])("%s can restore their own tenant", async (user) => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-yoga", user_id: user, access_token: "tok" });
    const res = await restore();
    expect(res.statusCode).toBe(200);
    expect(mocks.refineRestore).toHaveBeenCalledWith({ tenant_id: "tnt-yoga", conductor_run_id: "edit-colour" });
  });
});
