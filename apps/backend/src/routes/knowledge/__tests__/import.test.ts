import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const DOC = "11111111-1111-1111-1111-111111111111";
const h = vi.hoisted(() => ({
  role: true,
  enabled: true,
  doc: null as null | Record<string, unknown>,
  extractionSaved: null as unknown,
  read: vi.fn(),
  deleted: [] as string[],
  docDeleted: [] as string[],
  notes: [] as Array<Record<string, unknown>>,
  claim: true,
  releasedClaims: [] as string[],
  likePatterns: [] as string[],
  deleteClaim: true,
  stillMine: true,
  released: 0,
  machineRemoved: [] as unknown[],
  storageFails: false,
  nextCursor: null as string | null,
  noteById: null as Record<string, unknown> | null,
  asked: vi.fn(async () => {}),
  casWins: true,
  casAttempts: [] as string[],
}));
vi.mock("@/services/knowledge-import/ask-conflict", () => ({ askNextConflict: h.asked }));
vi.mock("@/services/company/facts", () => ({
  removeMachineFactsFromSource: vi.fn(async (_t: string, match: unknown) => { h.machineRemoved.push(match); return 1; }),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn(async () => ({ user_id: "u1", tenant_id: "t1", access_token: "tok" })) }));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_a: unknown, _r: unknown, res: Response) => {
    if (!h.role) res.status(403).json({});
    return h.role;
  }),
}));
vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn(async () => h.enabled) }));
vi.mock("@/services/personalization/documents", () => ({
  getDocument: vi.fn(async () => {
    if (!h.doc) throw Object.assign(new Error("not found"), { status: 404, code: "not_found" });
    return h.doc;
  }),
  claimDocumentRead: vi.fn(async () => (h.claim ? "claim-A" : null)),
  claimDocumentDeletion: vi.fn(async () => h.deleteClaim),
  releaseDocumentRead: vi.fn(async (_t: string, _id: string, claimId: string) => { h.released += 1; h.releasedClaims.push(claimId); }),
  beginReadCompensation: vi.fn(async (_t: string, _id: string, claimId: string) => { h.casAttempts.push(claimId); return h.casWins; }),
  finishReadCompensation: vi.fn(async (_t: string, _id: string, claimId: string) => { h.releasedClaims.push(claimId); }),
  downloadDocument: vi.fn(async () => Buffer.from("hello")),
  setDocumentExtraction: vi.fn(async (_t: string, _id: string, _c: string, e: unknown) => {
    h.extractionSaved = e;
    return h.stillMine;
  }),
  listImportedDocuments: vi.fn(async () => ({ documents: h.doc ? [h.doc] : [], next_cursor: h.nextCursor })),
  removeImportedObject: vi.fn(async () => {
    if (h.storageFails) throw new Error("storage down");
  }),
  deleteImportedRow: vi.fn(async (_t: string, id: string) => { h.docDeleted.push(id); }),
  DocumentError: class DocumentError extends Error {},
}));
vi.mock("@/services/knowledge-import/read", () => ({ readImportedFile: h.read }));
vi.mock("@/services/memory", () => ({ PRIVATE_NOTE_TYPES_PGREST_IN: "(agent_experience,agent_procedural)", deleteNote: vi.fn(async (_t: string, id: string) => { h.deleted.push(id); }) }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({
    from: () => {
      const q: Record<string, any> = {
        select: () => q, eq: () => q, not: () => q, is: () => q, like: (_c: string, v: string) => { h.likePatterns.push(v); return q; }, in: () => q, order: () => q,
        limit: async () => ({ data: h.notes, error: null }),
        maybeSingle: async () => ({ data: h.noteById, error: null }),
      };
      return q;
    },
  }),
}));

import { readImport, listImports, deleteImport, deleteImportedFact } from "../import";

function res() {
  const out = { statusCode: 200, body: undefined as any };
  const r = { status(c: number) { out.statusCode = c; return r; }, json(b: unknown) { out.body = b; return r; } };
  return { out, r: r as unknown as Response };
}
const req = (id = DOC) => ({ params: { id }, body: {} }) as unknown as Request;

beforeEach(() => {
  h.role = true; h.enabled = true; h.extractionSaved = null; h.deleted = []; h.docDeleted = []; h.notes = [];
  h.claim = true; h.deleteClaim = true; h.stillMine = true; h.released = 0; h.releasedClaims = []; h.likePatterns = []; h.machineRemoved = []; h.storageFails = false; h.nextCursor = null; h.noteById = null; h.casWins = true; h.casAttempts = [];
  h.doc = { id: DOC, filename: "a.md", status: "imported", storage_path: `t1/${DOC}/1/a.md`, extraction: null };
  h.read.mockReset();
  h.asked.mockClear();
  h.read.mockResolvedValue({ state: "read", facts: 2, redactions: 0, truncated: false, conflicts: [] });
});

describe("POST /api/knowledge/import/:id/read", () => {
  it("owner/admin only", async () => {
    h.role = false;
    const { out, r } = res();
    await readImport(req(), r);
    expect(out.statusCode).toBe(403);
    expect(h.read).not.toHaveBeenCalled();
  });
  it("refuses a non-imported document (never reads an approved file this way)", async () => {
    h.doc = { ...h.doc!, status: "approved" };
    const { out, r } = res();
    await readImport(req(), r);
    expect(out.statusCode).toBe(404);
  });
  it("reads once, stores the result without the conflict list, and answers it", async () => {
    const { out, r } = res();
    await readImport(req(), r);
    expect(out.body).toEqual({ state: "read", facts: 2, redactions: 0, truncated: false });
    expect(h.extractionSaved).toMatchObject({ state: "read", facts: 2 });
  });
  it("is idempotent: a lost claim returns the stored result without a second model call", async () => {
    h.claim = false;
    h.doc = { ...h.doc!, extraction: { state: "read", facts: 5, redactions: 1, truncated: false } };
    const { out, r } = res();
    await readImport(req(), r);
    expect(h.read).not.toHaveBeenCalled();
    expect(out.body.facts).toBe(5);
  });
  it("asks the next queued conflict after a fresh read", async () => {
    const { r } = res();
    await readImport(req(), r);
    expect(h.asked).toHaveBeenCalledTimes(1);
    expect(h.asked).toHaveBeenCalledWith({ tenant_id: "t1", user_id: "u1" });
  });
  it("a STORED extraction still asks, so a failed ask is never silenced", async () => {
    h.claim = false;
    h.doc = { ...h.doc!, extraction: { state: "read", facts: 5, redactions: 1, truncated: false } };
    const { r } = res();
    await readImport(req(), r);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.asked).toHaveBeenCalledTimes(1);
  });
  it("two simultaneous first reads: the loser gets 'reading' back, not a second read", async () => {
    h.claim = false;
    const { out, r } = res();
    await readImport(req(), r);
    expect(h.read).not.toHaveBeenCalled();
    expect(out.body).toEqual({ state: "reading" });
  });
  it("READ/DELETE RACE: a file removed mid-read keeps no late facts (the reader takes back what it wrote)", async () => {
    h.stillMine = false;
    h.notes = [{ id: "late-1" }];
    const { out, r } = res();
    await readImport(req(), r);
    expect(out.statusCode).toBe(409);
    expect(h.deleted).toEqual(["late-1"]);
    expect(h.machineRemoved).toEqual([{ prefix: `tenant_document:${DOC}#`, suffix: "~claim-A" }]);
  });
  it("STALE A / NEW B: A's late compensation removes only claim A's writes, never B's", async () => {
    h.stillMine = false;
    h.notes = [{ id: "a-note" }];
    const { r } = res();
    await readImport(req(), r);
    expect(h.likePatterns).toEqual([`tenant_document:${DOC}#%~claim-A`]);
    expect(h.machineRemoved).toEqual([{ prefix: `tenant_document:${DOC}#`, suffix: "~claim-A" }]);
  });
  const failRead = () => h.read.mockRejectedValueOnce(new Error("save failed on fact 3"));
  it("still READING under this claim: wins the compare-and-set, takes back this claim's facts, then frees the file", async () => {
    h.doc = { ...h.doc!, extraction: { state: "reading", claim_id: "claim-A" } };
    failRead();
    h.notes = [{ id: "partial-1" }, { id: "partial-2" }];
    const { out, r } = res();
    await readImport(req(), r);
    expect(out.statusCode).toBe(500);
    expect(h.casAttempts).toEqual(["claim-A"]);
    expect(h.likePatterns).toEqual([`tenant_document:${DOC}#%~claim-A`]);
    expect(h.deleted).toEqual(["partial-1", "partial-2"]);
    expect(h.machineRemoved).toEqual([{ prefix: `tenant_document:${DOC}#`, suffix: "~claim-A" }]);
    expect(h.releasedClaims).toEqual(["claim-A"]);
  });
  it("a LOST compare-and-set removes nothing (another caller owns the compensation)", async () => {
    h.doc = { ...h.doc!, extraction: { state: "reading", claim_id: "claim-A" } };
    h.casWins = false;
    failRead();
    h.notes = [{ id: "partial-1" }];
    const { out, r } = res();
    await readImport(req(), r);
    expect(out.statusCode).toBe(500);
    expect(h.deleted).toEqual([]);
    expect(h.releasedClaims).toEqual([]);
  });
  it.each([
    ["a successor's claim is reading", { state: "reading", claim_id: "claim-B" }],
    ["a successor's read was stored", { state: "read", facts: 3, claim_id: "claim-B" }],
    ["the file is being deleted", { state: "deleting" }],
    ["the claim was cleared", null],
  ])("when %s, this claim's orphan facts go (scoped by ~claim-A), and the row is left alone", async (_label, extraction) => {
    h.doc = { ...h.doc!, extraction };
    failRead();
    h.notes = [{ id: "orphan-1" }];
    const { out, r } = res();
    await readImport(req(), r);
    expect(out.statusCode).toBe(500);
    expect(h.likePatterns).toEqual([`tenant_document:${DOC}#%~claim-A`]);
    expect(h.deleted).toEqual(["orphan-1"]);
    expect(h.casAttempts).toEqual([]);
    expect(h.releasedClaims).toEqual([]);
  });
  it("the row is GONE (deleted meanwhile): this claim's orphan facts go", async () => {
    failRead();
    const { getDocument } = await import("@/services/personalization/documents");
    const g = getDocument as ReturnType<typeof vi.fn>;
    g.mockResolvedValueOnce(h.doc);
    g.mockRejectedValueOnce(Object.assign(new Error("not found"), { status: 404 }));
    h.notes = [{ id: "orphan-1" }];
    const { r } = res();
    await readImport(req(), r);
    expect(h.deleted).toEqual(["orphan-1"]);
  });
  it.each([
    ["the finalize COMMITTED under this claim before the throw", { state: "read", facts: 2, claim_id: "claim-A" }],
    ["a stored result with no claim to compare", { state: "read", facts: 2 }],
  ])("keeps the facts when %s, and still errors", async (_label, extraction) => {
    h.doc = { ...h.doc!, extraction };
    const { setDocumentExtraction } = await import("@/services/personalization/documents");
    (setDocumentExtraction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("socket hang up after commit"));
    h.notes = [{ id: "kept-1" }];
    const { out, r } = res();
    await readImport(req(), r);
    expect(out.statusCode).toBe(500);
    expect(h.deleted).toEqual([]);
    expect(h.machineRemoved).toEqual([]);
    expect(h.releasedClaims).toEqual([]);
  });
  it("keeps the facts when the re-read itself FAILS (unknown is not 'remove')", async () => {
    failRead();
    const { getDocument } = await import("@/services/personalization/documents");
    const g = getDocument as ReturnType<typeof vi.fn>;
    g.mockResolvedValueOnce(h.doc);
    g.mockRejectedValueOnce(Object.assign(new Error("db down"), { status: 500 }));
    h.notes = [{ id: "kept-1" }];
    const { out, r } = res();
    await readImport(req(), r);
    expect(out.statusCode).toBe(500);
    expect(h.deleted).toEqual([]);
  });
  it("the finalize stores the claim id with the result (so a later failure can tell whose it is)", async () => {
    const { r } = res();
    await readImport(req(), r);
    expect(h.extractionSaved).toMatchObject({ state: "read", claim_id: "claim-A" });
  });
  it("a file being taken back reads as 'reading' to a concurrent caller", async () => {
    h.claim = false;
    h.doc = { ...h.doc!, extraction: { state: "compensating", claim_id: "claim-A" } };
    const { out, r } = res();
    await readImport(req(), r);
    expect(out.body).toEqual({ state: "reading" });
  });
  it("400 on a bad id; 409 when the kill switch is off", async () => {
    const a = res(); await readImport(req("nope"), a.r); expect(a.out.statusCode).toBe(400);
    h.enabled = false;
    const b = res(); await readImport(req(), b.r); expect(b.out.statusCode).toBe(409);
  });
});

describe("DELETE /api/knowledge/imports/:id", () => {
  it("removes the file's facts, then the file", async () => {
    h.notes = [{ id: "n1" }, { id: "n2" }];
    const { out, r } = res();
    await deleteImport(req(), r);
    expect(out.statusCode).toBe(200);
    expect(h.deleted).toEqual(["n1", "n2"]);
    expect(h.machineRemoved).toEqual([{ prefix: `tenant_document:${DOC}#` }]);
    expect(h.docDeleted).toEqual([DOC]);
    expect(h.asked).toHaveBeenCalledWith({ tenant_id: "t1", user_id: "u1" });
  });
  it("deletion is refused while a fresh read holds the file (no mutation)", async () => {
    h.deleteClaim = false;
    const { out, r } = res();
    await deleteImport(req(), r);
    expect(out.statusCode).toBe(409);
    expect(h.deleted).toEqual([]);
    expect(h.docDeleted).toEqual([]);
  });
  it("a storage failure changes nothing (row, facts and company fields kept) and says so", async () => {
    h.notes = [{ id: "n1" }];
    h.storageFails = true;
    const { out, r } = res();
    await deleteImport(req(), r);
    expect(out.statusCode).toBe(500);
    expect(h.deleted).toEqual([]);
    expect(h.machineRemoved).toEqual([]);
    expect(h.docDeleted).toEqual([]);
  });
  it("works with the kill switch OFF (the founder can always remove stored data)", async () => {
    h.enabled = false;
    const { out, r } = res();
    await deleteImport(req(), r);
    expect(out.statusCode).toBe(200);
  });
});

describe("GET /api/knowledge/imports", () => {
  it("owner/admin only (the originals are unredacted)", async () => {
    h.role = false;
    const { out, r } = res();
    await listImports(req(), r);
    expect(out.statusCode).toBe(403);
  });
  it("groups facts under their file, returns the read result, and pages", async () => {
    h.doc = { ...h.doc!, extraction: { state: "read", facts: 1, truncated: true } };
    h.nextCursor = "2026-09-20T00:00:00Z";
    h.notes = [{ id: "n1", title: "Fact one", source_ref: `tenant_document:${DOC}#L3`, metadata: { document_id: DOC, quote: "quote one here", line: 3 } }];
    const { out, r } = res();
    await listImports(req(), r);
    expect(out.body.files[0]).toMatchObject({ id: DOC, extraction: { truncated: true }, facts: [{ id: "n1", text: "Fact one", quote: "quote one here", line: 3 }] });
    expect(out.body.next_cursor).toBe("2026-09-20T00:00:00Z");
  });
});

describe("DELETE /api/knowledge/facts/:id", () => {
  it("a member cannot delete an imported fact (no mutation)", async () => {
    h.role = false;
    const { out, r } = res();
    await deleteImportedFact(req(), r);
    expect(out.statusCode).toBe(403);
    expect(h.deleted).toEqual([]);
  });
  it("removes the note and the company field it filled (its key AND exact source_ref)", async () => {
    h.noteById = { id: DOC, source_ref: "tenant_document:d1#L9", metadata: { key: "industry" } };
    const { out, r } = res();
    await deleteImportedFact(req(), r);
    expect(out.statusCode).toBe(200);
    expect(h.machineRemoved).toEqual([{ exact: "tenant_document:d1#L9", key: "industry" }]);
    expect(h.deleted).toEqual([DOC]);
    expect(h.asked).toHaveBeenCalledWith({ tenant_id: "t1", user_id: "u1" });
  });
  it("a failed ask after the delete still answers 2xx", async () => {
    h.noteById = { id: DOC, source_ref: "tenant_document:d1#L9", metadata: {} };
    h.asked.mockRejectedValueOnce(new Error("chat down"));
    const { out, r } = res();
    await deleteImportedFact(req(), r);
    expect(out.statusCode).toBe(200);
  });
  it("a note-delete failure after the field delete is finished by a retry (2xx)", async () => {
    h.noteById = { id: DOC, source_ref: "tenant_document:d1#L9~c1", metadata: { key: "industry" } };
    const { deleteNote } = await import("@/services/memory");
    (deleteNote as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
    const first = res();
    await deleteImportedFact(req(), first.r);
    expect(first.out.statusCode).toBe(500);
    const second = res();
    await deleteImportedFact(req(), second.r);
    expect(second.out.statusCode).toBe(200);
    expect(h.machineRemoved).toHaveLength(2);
    expect(h.deleted).toEqual([DOC]);
  });
  it("an UNKEYED fact on the same line touches no company field", async () => {
    h.noteById = { id: DOC, source_ref: "tenant_document:d1#L9", metadata: {} };
    const { r } = res();
    await deleteImportedFact(req(), r);
    expect(h.machineRemoved).toEqual([]);
    expect(h.deleted).toEqual([DOC]);
  });
  it("404 for a note that is not an imported fact of this tenant", async () => {
    h.noteById = null;
    const { out, r } = res();
    await deleteImportedFact(req(), r);
    expect(out.statusCode).toBe(404);
  });
});
