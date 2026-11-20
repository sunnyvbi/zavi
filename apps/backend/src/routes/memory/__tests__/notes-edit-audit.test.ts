
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  auditCalls: [] as Array<Record<string, unknown>>,
  getNoteMock: vi.fn(),
  writeNoteMock: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (req: Request) => (req as { auth?: unknown }).auth ?? null,
}));

vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: async () => true,
}));

vi.mock("@/services/memory", () => ({
  writeNote: h.writeNoteMock,
  getNote: h.getNoteMock,
  deleteNote: vi.fn(),
  listNotes: vi.fn(),
  searchMemory: vi.fn(),
  listConflicts: vi.fn(),
  unsupersedeNote: vi.fn(),
  getDreamCycleStatus: vi.fn(),
  NoteNotFoundError: class NoteNotFoundError extends Error {},
  PRIVATE_NOTE_TYPE_SET: new Set(["agent_experience", "agent_procedural"]),
}));

vi.mock("@/services/memory/mutation-audit", () => ({
  writeMutationAudit: async (p: Record<string, unknown>) => {
    h.auditCalls.push(p);
  },
  buildEditSnapshot: (note: Record<string, unknown>) => ({
    redaction: "bounded_edit",
    note_id: note.id,
  }),
}));

import { memoryNoteUpsert } from "../notes";

const VALID_ID = "11111111-1111-1111-1111-111111111111";

function mkRes(): Response {
  const res: Record<string, unknown> = {};
  res.status = (_code: number) => res;
  res.json = (_payload: unknown) => res;
  return res as unknown as Response;
}

beforeEach(() => {
  h.auditCalls.length = 0;
  h.getNoteMock.mockReset();
  h.writeNoteMock.mockReset().mockResolvedValue({ note_id: VALID_ID, chunks: 1, entities: 0 });
});

describe("memoryNoteUpsert edit audit", () => {
  it("EDIT writes an audit row whose actor is the authed user, not the request body", async () => {
    h.getNoteMock.mockResolvedValue({
      id: VALID_ID,
      title: "Old title",
      body_markdown: "old body",
      source: "human",
      source_ref: null,
      slug: null,
      note_type: "untyped",
      tags: [],
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
    });

    const req = {
      params: { id: VALID_ID },
      body: {
        body_markdown: "new edited body",
        actor_user_id: "INJECTED-EVIL-ACTOR",
        reason: "operator fixed a typo",
      },
      auth: { user_id: "real-authed-user", tenant_id: "tenant-X", access_token: "tok" },
    } as unknown as Request;

    await memoryNoteUpsert(req, mkRes());

    expect(h.auditCalls).toHaveLength(1);
    const call = h.auditCalls[0];
    expect(call.action).toBe("edit");
    expect(call.note_id).toBe(VALID_ID);
    expect(call.tenant_id).toBe("tenant-X");
    expect(call.actor_user_id).toBe("real-authed-user");
    expect(call.actor_user_id).not.toBe("INJECTED-EVIL-ACTOR");
    expect(call.reason).toBe("operator fixed a typo");
  });

  it("a NEW note (no id, no existing) writes NO audit row", async () => {
    const req = {
      params: {},
      body: { body_markdown: "a brand new fact" },
      auth: { user_id: "real-authed-user", tenant_id: "tenant-X", access_token: "tok" },
    } as unknown as Request;

    await memoryNoteUpsert(req, mkRes());

    expect(h.writeNoteMock).toHaveBeenCalled();
    expect(h.auditCalls).toHaveLength(0);
  });
});

describe("memoryNoteUpsert: provenance and note type are the server's", () => {
  const auth = { user_id: "u1", tenant_id: "tenant-X", access_token: "tok" };
  const existing = {
    id: VALID_ID, title: "t", body_markdown: "b", source: "auto_distill_chat", source_ref: "r1",
    slug: null, note_type: "tenant_reference", tags: [],
    created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
  };
  const statusOf = () => {
    let code = 200;
    const res: Record<string, unknown> = {};
    res.status = (c: number) => { code = c; return res; };
    res.json = () => res;
    return { res: res as unknown as Response, code: () => code };
  };

  it("a client-sent source is ignored: a new note is human, an edit keeps its source", async () => {
    await memoryNoteUpsert({ params: {}, body: { title: "x", body_markdown: "y", source: "system" }, auth } as unknown as Request, mkRes());
    expect(h.writeNoteMock.mock.calls[0][1].source).toBe("human");
    h.getNoteMock.mockResolvedValue(existing);
    await memoryNoteUpsert({ params: { id: VALID_ID }, body: { body_markdown: "z", source: "human" }, auth } as unknown as Request, mkRes());
    expect(h.writeNoteMock.mock.calls[1][1].source).toBe("auto_distill_chat");
  });

  it("an edit without note_type keeps the note's type", async () => {
    h.getNoteMock.mockResolvedValue(existing);
    await memoryNoteUpsert({ params: { id: VALID_ID }, body: { body_markdown: "z" }, auth } as unknown as Request, mkRes());
    expect(h.writeNoteMock.mock.calls[0][1].note_type).toBe("tenant_reference");
  });

  it("a new operator_preference note is refused and pointed at the Rules page", async () => {
    const { res, code } = statusOf();
    await memoryNoteUpsert({ params: {}, body: { title: "x", body_markdown: "Never post on weekends", note_type: "operator_preference" }, auth } as unknown as Request, res);
    expect(code()).toBe(422);
    expect(h.writeNoteMock).not.toHaveBeenCalled();
  });

  it("an existing operator_preference note can still be edited as memory", async () => {
    h.getNoteMock.mockResolvedValue({ ...existing, note_type: "operator_preference" });
    await memoryNoteUpsert({ params: { id: VALID_ID }, body: { body_markdown: "z", note_type: "operator_preference" }, auth } as unknown as Request, mkRes());
    expect(h.writeNoteMock).toHaveBeenCalledTimes(1);
  });
});

