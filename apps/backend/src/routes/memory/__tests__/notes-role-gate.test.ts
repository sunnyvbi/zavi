import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  role: "member" as string | null,
  roleReads: [] as Array<Record<string, unknown>>,
  writeNote: vi.fn(),
  deleteNote: vi.fn(),
  unsupersedeNote: vi.fn(),
  getNote: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (req: Request) => (req as { auth?: unknown }).auth ?? null,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = { table };
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return q;
        },
        maybeSingle: async () => {
          h.roleReads.push({ ...filters });
          if (table !== "tenant_users") throw new Error(`unexpected table ${table}`);
          return { data: h.role === null ? null : { role: h.role }, error: null };
        },
      };
      return q;
    },
  }),
}));

vi.mock("@/services/memory", () => ({
  writeNote: h.writeNote,
  getNote: h.getNote,
  deleteNote: h.deleteNote,
  listNotes: vi.fn(),
  searchMemory: vi.fn(),
  listConflicts: vi.fn(),
  unsupersedeNote: h.unsupersedeNote,
  getDreamCycleStatus: vi.fn(),
  NoteNotFoundError: class NoteNotFoundError extends Error {},
  PRIVATE_NOTE_TYPE_SET: new Set(["agent_experience", "agent_procedural"]),
}));

vi.mock("@/services/memory/mutation-audit", () => ({
  writeMutationAudit: h.audit,
  buildEditSnapshot: () => ({}),
}));

import { memoryNoteUpsert, memoryNoteDelete, memoryNoteUnsupersede } from "../notes";

const NOTE_ID = "22222222-2222-2222-2222-222222222222";
const auth = { user_id: "user-7", tenant_id: "tenant-Q", access_token: "tok" };

function mkRes() {
  const out = { code: 200, body: undefined as unknown };
  const res: Record<string, unknown> = {};
  res.status = (c: number) => {
    out.code = c;
    return res;
  };
  res.json = (b: unknown) => {
    out.body = b;
    return res;
  };
  return { res: res as unknown as Response, out };
}

type Call = { name: string; run: (res: Response) => Promise<void> };

const calls: Call[] = [
  {
    name: "POST create",
    run: (res) =>
      memoryNoteUpsert({ params: {}, body: { title: "t", body_markdown: "new fact" }, auth } as unknown as Request, res),
  },
  {
    name: "POST with id",
    run: (res) =>
      memoryNoteUpsert({ params: {}, body: { id: NOTE_ID, body_markdown: "edited" }, auth } as unknown as Request, res),
  },
  {
    name: "PUT",
    run: (res) =>
      memoryNoteUpsert({ params: { id: NOTE_ID }, body: { body_markdown: "edited" }, auth } as unknown as Request, res),
  },
  {
    name: "DELETE",
    run: (res) =>
      memoryNoteDelete({ params: { id: NOTE_ID }, body: { reason: "x" }, auth } as unknown as Request, res),
  },
  {
    name: "unsupersede",
    run: (res) => memoryNoteUnsupersede({ params: { id: NOTE_ID }, body: {}, auth } as unknown as Request, res),
  },
];

beforeEach(() => {
  h.roleReads.length = 0;
  h.writeNote.mockReset().mockResolvedValue({ note_id: NOTE_ID, chunks: 1, entities: 0 });
  h.deleteNote.mockReset().mockResolvedValue(undefined);
  h.unsupersedeNote.mockReset().mockResolvedValue(undefined);
  h.audit.mockReset().mockResolvedValue(undefined);
  h.getNote.mockReset().mockResolvedValue({
    id: NOTE_ID,
    title: "Existing",
    body_markdown: "old",
    source: "human",
    source_ref: null,
    slug: null,
    note_type: "tenant_reference",
    tags: ["a"],
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
  });
});

describe("memory note writes are owner/admin only", () => {
  for (const role of ["member", "viewer", null] as const) {
    for (const call of calls) {
      it(`${call.name} is refused with 403 for role ${role ?? "none"} and never touches memory`, async () => {
        h.role = role;
        const { res, out } = mkRes();
        await call.run(res);
        expect(out.code).toBe(403);
        expect((out.body as { error: { code: string } }).error.code).toBe("forbidden");
        expect(h.roleReads).toEqual([
          { table: "tenant_users", user_id: "user-7", tenant_id: "tenant-Q" },
        ]);
        expect(h.writeNote).not.toHaveBeenCalled();
        expect(h.deleteNote).not.toHaveBeenCalled();
        expect(h.unsupersedeNote).not.toHaveBeenCalled();
        expect(h.getNote).not.toHaveBeenCalled();
        expect(h.audit).not.toHaveBeenCalled();
      });
    }
  }

  for (const role of ["owner", "admin"] as const) {
    it(`${role} can create, edit, delete and unsupersede`, async () => {
      h.role = role;
      for (const call of calls) {
        const { res, out } = mkRes();
        await call.run(res);
        expect(out.code, call.name).toBe(200);
      }
      expect(h.writeNote).toHaveBeenCalledTimes(3);
      expect(h.writeNote.mock.calls.every((c) => c[0] === "tenant-Q")).toBe(true);
      expect(h.deleteNote).toHaveBeenCalledWith("tenant-Q", NOTE_ID, "user-7", "x");
      expect(h.unsupersedeNote).toHaveBeenCalledWith("tenant-Q", NOTE_ID);
    });
  }
});
