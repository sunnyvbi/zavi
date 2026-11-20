import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const DOC = "11111111-1111-1111-1111-111111111111";
const h = vi.hoisted(() => ({
  role: true,
  doc: null as null | Record<string, unknown>,
  listOpts: null as unknown,
  signed: 0,
  enabled: true,
  settingsFail: false,
  uploads: [] as unknown[],
  sent: [] as unknown[],
  sendFails: false,
}));
vi.mock("@/../workers/client", () => ({
  inngest: {
    send: vi.fn(async (e: unknown) => {
      if (h.sendFails) throw new Error("inngest down");
      h.sent.push(e);
    }),
  },
}));
vi.mock("@/services/settings", () => ({
  getBoolSettingStrictResolved: vi.fn(async () => {
    if (h.settingsFail) throw new Error("strict setting read failed");
    return h.enabled;
  }),
}));

vi.mock("@/services/auth/middleware", () => ({
  authMiddleware: vi.fn(),
  requireAuth: vi.fn(async () => ({ user_id: "u1", tenant_id: "t1", access_token: "tok" })),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_a: unknown, _r: unknown, res: Response) => {
    if (!h.role) res.status(403).json({});
    return h.role;
  }),
}));
vi.mock("@/services/personalization/documents", () => ({
  MAX_DOCUMENT_BYTES: 25 * 1024 * 1024,
  DocumentError: class DocumentError extends Error {},
  deleteDocument: vi.fn(),
  replaceDocument: vi.fn(),
  setDocumentStatus: vi.fn(),
  uploadDocument: vi.fn(async (_t: string, input: unknown) => { h.uploads.push(input); return { id: "new" }; }),
  listDocuments: vi.fn(async (_t: string, _s: unknown, opts: { excludeImported?: boolean }) => {
    h.listOpts = opts;
    const all = [
      { id: "a", status: "approved" },
      { id: "b", status: "imported" },
    ];
    return opts?.excludeImported ? all.filter((d) => d.status !== "imported") : all;
  }),
  getDocument: vi.fn(async () => h.doc),
  signedDownloadUrl: vi.fn(async () => {
    h.signed += 1;
    return "https://signed";
  }),
}));

import { listPersonalizationDocuments, personalizationDocumentUrl, uploadPersonalizationDocument } from "../documents";

function res() {
  const out = { statusCode: 200, body: undefined as any };
  const r = { status(c: number) { out.statusCode = c; return r; }, json(b: unknown) { out.body = b; return r; } };
  return { out, r: r as unknown as Response };
}
const req = (id = DOC) => ({ params: { id }, query: {}, body: {} }) as unknown as Request;

beforeEach(() => {
  h.role = true;
  h.listOpts = null;
  h.signed = 0;
  h.enabled = true;
  h.settingsFail = false;
  h.uploads = [];
  h.sent = [];
  h.sendFails = false;
  h.doc = { id: DOC, status: "imported", storage_path: `t1/${DOC}/1/a.md` };
});

describe("personalization documents: imported originals stay off member routes", () => {
  it("the generic list never contains an imported row", async () => {
    const { out, r } = res();
    await listPersonalizationDocuments(req(), r);
    expect(h.listOpts).toEqual({ excludeImported: true });
    expect(out.body.documents.map((d: { status: string }) => d.status)).not.toContain("imported");
  });
  it("a member asking for an imported file's URL gets 403 and no URL is signed", async () => {
    h.role = false;
    const { out, r } = res();
    await personalizationDocumentUrl(req(), r);
    expect(out.statusCode).toBe(403);
    expect(h.signed).toBe(0);
  });
  it("an owner gets the imported file's URL", async () => {
    const { out, r } = res();
    await personalizationDocumentUrl(req(), r);
    expect(out.statusCode).toBe(200);
    expect(out.body.url).toBe("https://signed");
  });
  it("an approved file's URL needs no role (today's member access)", async () => {
    h.role = false;
    h.doc = { ...h.doc!, status: "approved" };
    const { out, r } = res();
    await personalizationDocumentUrl(req(), r);
    expect(out.statusCode).toBe(200);
    expect(h.signed).toBe(1);
  });
});

describe("POST /api/personalization/documents?purpose=import (kill switch)", () => {
  const upReq = (purpose?: string) =>
    ({ params: {}, query: purpose ? { purpose } : {}, body: {}, file: { buffer: Buffer.from("x"), originalname: "a.md", mimetype: "text/markdown" } }) as unknown as Request;
  it("with the welcome setup OFF an import is refused and nothing is stored", async () => {
    h.enabled = false;
    const { out, r } = res();
    await uploadPersonalizationDocument(upReq("import"), r);
    expect(out.statusCode).toBe(409);
    expect(out.body.error.code).toBe("feature_disabled");
    expect(h.uploads).toEqual([]);
  });
  it("a settings read ERROR answers 503 and stores nothing (fails closed)", async () => {
    h.settingsFail = true;
    const { out, r } = res();
    await uploadPersonalizationDocument(upReq("import"), r);
    expect(out.statusCode).toBe(503);
    expect(out.body.error.code).toBe("settings_unavailable");
    expect(h.uploads).toEqual([]);
  });
  it("with it ON an import is stored as imported; a plain upload ignores the switch", async () => {
    const a = res();
    await uploadPersonalizationDocument(upReq("import"), a.r);
    expect(a.out.statusCode).toBe(201);
    expect(h.uploads[0]).toMatchObject({ status: "imported" });
    h.enabled = false;
    const b = res();
    await uploadPersonalizationDocument(upReq(), b.r);
    expect(b.out.statusCode).toBe(201);
    expect(h.uploads[1]).toMatchObject({ status: "approved" });
  });
  it("an import starts its background read (doc id + a trace-only tenant); a plain upload does not", async () => {
    const a = res();
    await uploadPersonalizationDocument(upReq("import"), a.r);
    expect(h.sent).toEqual([{ name: "knowledge/import.read", data: { doc_id: "new", tenant_id: "t1" } }]);
    const b = res();
    await uploadPersonalizationDocument(upReq(), b.r);
    expect(h.sent).toHaveLength(1);
  });
  it("a failed send never fails the upload (the page can still ask for the read)", async () => {
    h.sendFails = true;
    const { out, r } = res();
    await uploadPersonalizationDocument(upReq("import"), r);
    expect(out.statusCode).toBe(201);
    expect(out.body.document).toEqual({ id: "new" });
  });
});
