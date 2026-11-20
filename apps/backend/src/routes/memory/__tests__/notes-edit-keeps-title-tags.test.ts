import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  existing: null as Record<string, unknown> | null,
  updates: [] as Array<{ table: string; payload: Record<string, unknown>; filters: Record<string, unknown> }>,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (req: Request) => (req as { auth?: unknown }).auth ?? null,
}));

vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: async () => true,
}));

vi.mock("@/services/memory/mutation-audit", () => ({
  writeMutationAudit: async () => undefined,
  buildEditSnapshot: () => ({}),
}));

vi.mock("@/services/supabase", () => {
  const client = {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let mode: "select" | "update" = "select";
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (col: string, val: unknown) => {
        filters[col] = val;
        return q;
      };
      q.update = (payload: Record<string, unknown>) => {
        mode = "update";
        h.updates.push({ table, payload, filters });
        return q;
      };
      q.maybeSingle = async () => {
        if (table === "memory_note" && mode === "select") {
          const row = h.existing;
          const hit = row && filters.id === row.id && filters.tenant_id === "tenant-X";
          return { data: hit ? row : null, error: null };
        }
        return { data: null, error: null };
      };
      q.single = q.maybeSingle;
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  return { serviceClient: () => client, serverClientFromBearer: () => client };
});

import { memoryNoteUpsert } from "../notes";

const NOTE_ID = "33333333-3333-3333-3333-333333333333";
const auth = { user_id: "u1", tenant_id: "tenant-X", access_token: "tok" };

function mkRes(): Response {
  const res: Record<string, unknown> = {};
  res.status = () => res;
  res.json = () => res;
  return res as unknown as Response;
}

function noteUpdate() {
  const u = h.updates.filter((x) => x.table === "memory_note");
  expect(u).toHaveLength(1);
  return u[0];
}

beforeEach(() => {
  h.updates.length = 0;
  h.existing = {
    id: NOTE_ID,
    title: "Late return fee",
    body_markdown: "We charge 20 per hour late.",
    source: "agent_distill",
    source_ref: "run-9",
    slug: null,
    note_type: "tenant_reference",
    tags: ["pricing", "returns"],
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
  };
});

describe("PUT /api/memory/notes/:id keeps title and tags the client did not send", () => {
  it("an edit that sends only body_markdown writes the prior title and tags to memory_note", async () => {
    await memoryNoteUpsert(
      { params: { id: NOTE_ID }, body: { body_markdown: "We charge 25 per hour late.", reason: "fix" }, auth } as unknown as Request,
      mkRes(),
    );
    const u = noteUpdate();
    expect(u.filters).toEqual({ id: NOTE_ID, tenant_id: "tenant-X" });
    expect(u.payload.title).toBe("Late return fee");
    expect(u.payload.tags).toEqual(["pricing", "returns"]);
    expect(u.payload.body_markdown).toBe("We charge 25 per hour late.");
    expect(u.payload.source).toBe("agent_distill");
    expect(u.payload.note_type).toBe("tenant_reference");
  });

  it("an edit that sends title and tags explicitly still overrides them, including an empty tag list", async () => {
    await memoryNoteUpsert(
      { params: { id: NOTE_ID }, body: { body_markdown: "b", title: "Renamed", tags: [] }, auth } as unknown as Request,
      mkRes(),
    );
    const u = noteUpdate();
    expect(u.payload.title).toBe("Renamed");
    expect(u.payload.tags).toEqual([]);
  });
});
