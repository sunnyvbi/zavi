
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { makeDb, type Tables } from "@/services/analytics/__tests__/fake-db";

const h = vi.hoisted(() => ({ db: null as null | { client: unknown }, requireAuth: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => h.db!.client }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: h.requireAuth }));

import { deleteDataNoteHandler, listDataNotesHandler } from "../data-notes";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const NOTE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function res() {
  const r = { statusCode: 200, body: undefined as unknown } as { statusCode: number; body: unknown } & Partial<Response>;
  r.status = vi.fn((c: number) => {
    r.statusCode = c;
    return r as Response;
  }) as unknown as Response["status"];
  r.json = vi.fn((b: unknown) => {
    r.body = b;
    return r as Response;
  }) as unknown as Response["json"];
  return r;
}

let tables: Tables;
beforeEach(() => {
  tables = {
    tenant_data_notes: [
      {
        id: NOTE_A,
        tenant_id: A,
        metric_id: "net_revenue",
        note_text: "Revenue excludes test orders",
        created_by: null,
        created_at: "2026-09-28T10:00:00Z",
        active: true,
      },
    ],
    tenant_users: [
      { tenant_id: A, user_id: "owner-a", role: "owner" },
      { tenant_id: A, user_id: "member-a", role: "member" },
      { tenant_id: B, user_id: "owner-b", role: "owner" },
      { tenant_id: A, user_id: "owner-b", role: "member" },
    ],
  };
  h.db = makeDb(tables);
  h.requireAuth.mockReset();
});

const as = (tenant_id: string, user_id: string) => h.requireAuth.mockResolvedValue({ tenant_id, user_id, access_token: "t" });

describe("GET /api/tenant/me/data-notes", () => {
  it("lists the authed tenant's notes with the metric label", async () => {
    as(A, "member-a");
    const r = res();
    await listDataNotesHandler({} as Request, r as Response);
    expect(r.body).toEqual({
      notes: [
        { id: NOTE_A, metric_id: "net_revenue", metric_label: expect.any(String), note_text: "Revenue excludes test orders", created_at: "2026-09-28T10:00:00Z" },
      ],
    });
  });

  it("another tenant sees none of them", async () => {
    as(B, "owner-b");
    const r = res();
    await listDataNotesHandler({} as Request, r as Response);
    expect(r.body).toEqual({ notes: [] });
  });
});

describe("DELETE /api/tenant/me/data-notes/:id", () => {
  it("an owner of another tenant gets a 404 and the note stays active", async () => {
    as(B, "owner-b");
    const r = res();
    await deleteDataNoteHandler({ params: { id: NOTE_A } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(404);
    expect(tables.tenant_data_notes[0].active).toBe(true);
  });

  it("a member of the same tenant is refused", async () => {
    as(A, "member-a");
    const r = res();
    await deleteDataNoteHandler({ params: { id: NOTE_A } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(403);
    expect(tables.tenant_data_notes[0].active).toBe(true);
  });

  it("the owner deactivates it (kept, not deleted)", async () => {
    as(A, "owner-a");
    const r = res();
    await deleteDataNoteHandler({ params: { id: NOTE_A } } as unknown as Request, r as Response);
    expect(r.body).toEqual({ removed: true });
    expect(tables.tenant_data_notes).toHaveLength(1);
    expect(tables.tenant_data_notes[0]).toMatchObject({ active: false, deactivated_by: "owner-a" });
  });

  it("rejects a malformed id", async () => {
    as(A, "owner-a");
    const r = res();
    await deleteDataNoteHandler({ params: { id: "not-a-uuid" } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(400);
  });
});
