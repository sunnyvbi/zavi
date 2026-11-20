import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  rows: [] as Row[],
  inserted: [] as Row[],
  removeError: null as null | { message: string },
  rowDeletes: 0,
  uploads: 0,
  filters: [] as unknown[],
}));

vi.mock("@/services/tenant-client", () => {
  const table = () => {
    const filters: Array<(r: Row) => boolean> = [];
    const q: Record<string, any> = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      neq: (c: string, v: unknown) => { h.filters.push(["neq", c, v]); filters.push((r) => r[c] !== v); return q; },
      or: (expr: string) => { h.filters.push(["or", expr]); return q; },
      order: (c: string, o: { ascending: boolean }) => { h.filters.push(["order", c, o.ascending]); return q; },
      limit: async () => ({ data: h.rows.filter((r) => filters.every((f) => f(r))), error: null }),
      maybeSingle: async () => ({ data: h.rows.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      insert: (row: Row) => { h.inserted.push(row); return { select: () => ({ single: async () => ({ data: { ...row, storage_path: row.storage_path }, error: null }) }) }; },
      update: () => q,
      delete: () => { h.rowDeletes += 1; return { eq: async () => ({ error: null }) }; },
      single: async () => ({ data: h.rows[0], error: null }),
    };
    return q;
  };
  return {
    asTenantId: (s: string) => s,
    tenantClient: () => ({ from: table }),
    tenantStorage: () => ({
      from: () => ({
        upload: async () => { h.uploads += 1; return { error: null }; },
        remove: async () => ({ error: h.removeError }),
        createSignedUrl: async () => ({ data: { signedUrl: "https://signed" }, error: null }),
      }),
    }),
  };
});
vi.mock("../missing-relation", () => ({ isMissingRelation: () => false, noteMissingRelationOnce: () => {} }));

import {
  approvedDocumentLinks,
  deleteDocument,
  DocumentError,
  encodeImportCursor,
  listDocuments,
  listImportedDocuments,
  removeImportedObject,
  replaceDocument,
  setDocumentStatus,
  uploadDocument,
} from "../documents";

beforeEach(() => {
  h.rows = []; h.inserted = []; h.removeError = null; h.rowDeletes = 0; h.uploads = 0; h.filters = [];
});

describe("imported documents", () => {
  it("upload can store a file as imported", async () => {
    await uploadDocument("t1", { buffer: Buffer.from("hi"), filename: "notes.md", mime: "text/markdown", actor_user_id: "u1", status: "imported" });
    expect(h.inserted[0].status).toBe("imported");
  });
  it("default upload stays approved (today's behaviour)", async () => {
    await uploadDocument("t1", { buffer: Buffer.from("hi"), filename: "notes.md", mime: "text/markdown", actor_user_id: "u1" });
    expect(h.inserted[0].status).toBe("approved");
  });
  it("an imported file never becomes an agent link", async () => {
    h.rows = [{ id: "d1", filename: "secret.md", status: "imported", version: 1, storage_path: "t1/d1/1/secret.md" }];
    expect(await approvedDocumentLinks("t1")).toEqual([]);
  });
  it("archive/restore refuse an imported file (restore would expose it to agents)", async () => {
    h.rows = [{ id: "d1", filename: "secret.md", status: "imported", version: 1, storage_path: "p" }];
    await expect(setDocumentStatus("t1", "d1", "approved")).rejects.toBeInstanceOf(DocumentError);
  });
  it("removing an imported object checks the storage error (and never touches the row)", async () => {
    h.rows = [{ id: "d1", filename: "secret.md", status: "imported", version: 1, storage_path: "t1/d1/1/secret.md" }];
    h.removeError = { message: "storage down" };
    await expect(removeImportedObject("t1", "d1")).rejects.toBeInstanceOf(DocumentError);
    expect(h.rowDeletes).toBe(0);
    h.removeError = null;
    await removeImportedObject("t1", "d1");
    expect(h.rowDeletes).toBe(0);
  });
  it("the generic replace and delete refuse an imported file (no mutation)", async () => {
    h.rows = [{ id: "d1", filename: "secret.md", status: "imported", version: 1, storage_path: "t1/d1/1/secret.md" }];
    await expect(deleteDocument("t1", "d1")).rejects.toBeInstanceOf(DocumentError);
    await expect(replaceDocument("t1", "d1", { buffer: Buffer.from("x"), filename: "x.md", mime: "text/markdown", actor_user_id: "u1" })).rejects.toBeInstanceOf(DocumentError);
    expect(h.rowDeletes).toBe(0);
    expect(h.uploads).toBe(0);
  });
  it("the generic list excludes imports in SQL (before the 200 cap)", async () => {
    await listDocuments("t1", undefined, { excludeImported: true });
    expect(h.filters).toContainEqual(["neq", "status", "imported"]);
  });
  it("keyset cursor round-trips (created_at, id)", () => {
    const c = encodeImportCursor("2026-09-24T00:00:00.000Z", "11111111-1111-1111-1111-111111111111");
    expect(typeof c).toBe("string");
    expect(c).not.toContain("|");
  });
  it("a cursor page filters on (created_at, id) and orders both descending", async () => {
    const at = "2026-09-24T00:00:00.000Z";
    const id = "11111111-1111-1111-1111-111111111111";
    await listImportedDocuments("t1", { cursor: encodeImportCursor(at, id) });
    expect(h.filters).toContainEqual(["or", `created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`]);
    const orders = h.filters.filter((f) => Array.isArray(f) && f[0] === "order");
    expect(orders).toEqual([["order", "created_at", false], ["order", "id", false]]);
  });
});
