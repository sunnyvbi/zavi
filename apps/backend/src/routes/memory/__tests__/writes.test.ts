import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  svc: {
    getRunWrites: vi.fn(),
    listRecentWrites: vi.fn(),
    forgetNote: vi.fn(),
    undoForget: vi.fn(),
    undoUpdate: vi.fn(),
    listOpenConflicts: vi.fn(),
    keepConflictValue: vi.fn(),
    restoreWrite: vi.fn(),
  },
  sent: [] as unknown[],
  role: "owner" as string,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (req: Request) => (req as { auth?: unknown }).auth ?? null,
}));
vi.mock("@/services/memory/remembered", () => h.svc);
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: async (_auth: unknown, roles: readonly string[], res: Response) => {
    if (roles.includes(h.role)) return true;
    res.status(403).json({ error: { code: "forbidden_role" } });
    return false;
  },
}));
vi.mock("@/../workers/client", () => ({
  inngest: { send: vi.fn(async (e: unknown) => h.sent.push(e)) },
}));

import {
  memoryWritesGet,
  memoryRecentWrites,
  memoryNoteForget,
  memoryForgetUndo,
  memoryNoteUndoUpdate,
  memoryOpenConflicts,
  memoryConflictKeep,
  memoryWriteRestore,
} from "../writes";

const T = "11111111-1111-1111-1111-111111111111";
const U = "22222222-2222-2222-2222-222222222222";
const ID = "33333333-3333-3333-3333-333333333333";
const ID2 = "44444444-4444-4444-4444-444444444444";

function call(
  handler: (req: Request, res: Response) => Promise<void>,
  req: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown; authed?: boolean },
) {
  const out: { status: number; body: unknown } = { status: 200, body: undefined };
  const res = {
    status(c: number) {
      out.status = c;
      return res;
    },
    json(b: unknown) {
      out.body = b;
      return res;
    },
  } as unknown as Response;
  const r = {
    params: req.params ?? {},
    query: req.query ?? {},
    body: req.body ?? {},
    auth: req.authed === false ? undefined : { tenant_id: T, user_id: U },
  } as unknown as Request;
  return handler(r, res).then(() => out);
}

beforeEach(() => {
  for (const f of Object.values(h.svc)) f.mockReset();
  h.sent.length = 0;
});

describe("GET /api/memory/writes", () => {
  it("takes run_id (chat replies and runs alike) and scopes to the auth tenant", async () => {
    h.svc.getRunWrites.mockResolvedValue({ status: "done", items: [] });
    const out = await call(memoryWritesGet, { query: { run_id: ID } });
    expect(out).toEqual({ status: 200, body: { status: "done", items: [] } });
    expect(h.svc.getRunWrites).toHaveBeenCalledWith(T, { run_id: ID, thread_message_id: null });
  });

  it("400 without a ref or with a bad id; 404 when the run is not this tenant's", async () => {
    expect((await call(memoryWritesGet, {})).status).toBe(400);
    expect((await call(memoryWritesGet, { query: { run_id: "x" } })).status).toBe(400);
    h.svc.getRunWrites.mockResolvedValue(null);
    expect((await call(memoryWritesGet, { query: { thread_message_id: ID } })).status).toBe(404);
  });

  it("does nothing when unauthenticated", async () => {
    const out = await call(memoryWritesGet, { query: { run_id: ID }, authed: false });
    expect(h.svc.getRunWrites).not.toHaveBeenCalled();
    expect(out.body).toBeUndefined();
  });
});

describe("GET /api/memory/recent-writes", () => {
  it("validates since/before and caps limit", async () => {
    h.svc.listRecentWrites.mockResolvedValue([{ note_id: ID, created_at: "2026-09-29T00:00:00.000Z" }]);
    const out = await call(memoryRecentWrites, { query: { since: "2026-09-01T00:00:00Z", limit: "500" } });
    expect(h.svc.listRecentWrites).toHaveBeenCalledWith(T, { since: "2026-09-01T00:00:00.000Z", before: null, limit: 100 });
    expect(out.body).toMatchObject({ next_before: "2026-09-29T00:00:00.000Z" });
    expect((await call(memoryRecentWrites, { query: { since: "nope" } })).status).toBe(400);
  });
});

describe("Forget + undo", () => {
  it("forgets, fires the delayed purge event, returns the undo token", async () => {
    h.svc.forgetNote.mockResolvedValue({ ok: true, undo_token: ID2, undo_expires_at: "t" });
    const out = await call(memoryNoteForget, { params: { id: ID } });
    expect(out.body).toEqual({ undo_token: ID2, undo_expires_at: "t" });
    expect(h.svc.forgetNote).toHaveBeenCalledWith(T, ID, U);
    expect(h.sent).toEqual([{ name: "memory.note.forget.requested", data: { request_id: ID2, tenant_id: T } }]);
  });

  it("404 for a note not in this tenant, 409 for an anchor", async () => {
    h.svc.forgetNote.mockResolvedValue({ ok: false, code: "not_found" });
    expect((await call(memoryNoteForget, { params: { id: ID } })).status).toBe(404);
    h.svc.forgetNote.mockResolvedValue({ ok: false, code: "anchor" });
    expect((await call(memoryNoteForget, { params: { id: ID } })).status).toBe(409);
    expect(h.sent).toHaveLength(0);
  });

  it("undo: 409 once the window passed, 400 on a bad token", async () => {
    h.svc.undoForget.mockResolvedValue(false);
    expect((await call(memoryForgetUndo, { body: { undo_token: ID2 } })).status).toBe(409);
    expect((await call(memoryForgetUndo, { body: { undo_token: "x" } })).status).toBe(400);
    h.svc.undoForget.mockResolvedValue(true);
    expect((await call(memoryForgetUndo, { body: { undo_token: ID2 } })).body).toEqual({ ok: true });
    expect(h.svc.undoForget).toHaveBeenLastCalledWith(T, ID2);
  });
});

describe("undo-update, conflicts, restore", () => {
  it("undo-update: 409 when the note replaced nothing", async () => {
    h.svc.undoUpdate.mockResolvedValue(null);
    expect((await call(memoryNoteUndoUpdate, { params: { id: ID } })).status).toBe(409);
    h.svc.undoUpdate.mockResolvedValue(ID2);
    expect((await call(memoryNoteUndoUpdate, { params: { id: ID } })).body).toEqual({ ok: true, restored_note_id: ID2 });
  });

  it("GET conflicts returns { pairs } and a page cursor", async () => {
    h.svc.listOpenConflicts.mockResolvedValue([{ pair_id: ID, values: [], created_at: "c" }]);
    const out = await call(memoryOpenConflicts, { query: {} });
    expect(out.body).toEqual({ pairs: [{ pair_id: ID, values: [], created_at: "c" }], next_before: "c" });
  });

  it("keep: validates ids and maps the outcomes", async () => {
    expect((await call(memoryConflictKeep, { params: { pair_id: ID }, body: {} })).status).toBe(400);
    h.svc.keepConflictValue.mockResolvedValue("not_in_pair");
    expect((await call(memoryConflictKeep, { params: { pair_id: ID }, body: { note_id: ID2 } })).status).toBe(400);
    h.svc.keepConflictValue.mockResolvedValue("not_open");
    expect((await call(memoryConflictKeep, { params: { pair_id: ID }, body: { note_id: ID2 } })).status).toBe(409);
    h.svc.keepConflictValue.mockResolvedValue("kept");
    expect((await call(memoryConflictKeep, { params: { pair_id: ID }, body: { note_id: ID2 } })).body).toEqual({ ok: true });
    expect(h.svc.keepConflictValue).toHaveBeenLastCalledWith(T, ID, ID2, U);
  });

  it("restore maps its outcomes", async () => {
    h.svc.restoreWrite.mockResolvedValue("not_found");
    expect((await call(memoryWriteRestore, { params: { id: ID } })).status).toBe(404);
    h.svc.restoreWrite.mockResolvedValue("restored");
    expect((await call(memoryWriteRestore, { params: { id: ID } })).body).toEqual({ ok: true });
  });
});

describe("members cannot change notes through the Remembered routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.role = "member";
  });
  it.each([
    ["forget", memoryNoteForget, { params: { id: ID } }],
    ["forget undo", memoryForgetUndo, { body: { undo_token: "x" } }],
    ["undo-update", memoryNoteUndoUpdate, { params: { id: ID } }],
    ["conflict keep", memoryConflictKeep, { body: { keep_id: ID, drop_id: ID2 } }],
    ["write restore", memoryWriteRestore, { params: { id: ID } }],
  ] as const)("%s is 403 for a member and touches nothing", async (_n, handler, req) => {
    const out = await call(handler as never, req as never);
    expect(out.status).toBe(403);
    for (const fn of Object.values(h.svc)) expect(fn).not.toHaveBeenCalled();
    h.role = "owner";
  });
});
