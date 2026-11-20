import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { request as httpRequest, type ClientRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const auth = vi.hoisted(() => ({ tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as string | null }));

vi.mock("@/services/supabase", async () => {
  const { fake } = await import("@/services/workspace-files/__tests__/fake-supabase");
  return { serviceClient: () => fake.client() };
});
vi.hoisted(() => {
  process.env.BACKEND_PUBLIC_URL = "https://api.test.zavi/";
});
vi.mock("@/services/auth/middleware", () => {
  const requireAuth = vi.fn(
    async (
      req: { headers?: Record<string, string | undefined>; auth?: unknown },
      res: { status: (n: number) => { json: (b: unknown) => void } },
    ) => {
      const tenant = req.headers?.["x-test-tenant"] ?? auth.tenant_id;
      if (!tenant) {
        res.status(401).json({ error: { code: "unauthenticated", message: "no" } });
        return null;
      }
      const who = { tenant_id: tenant, user_id: req.headers?.["x-test-user"] ?? "user-1", access_token: "t" };
      req.auth = who;
      return who;
    },
  );
  return {
    requireAuth,
    authMiddleware: vi.fn(async (req: never, res: never, next: () => void) => {
      if (await requireAuth(req, res)) next();
    }),
  };
});

import { _resetIndexMemoForTest } from "@/services/workspace-files/workspace-files";
import {
  BUCKET,
  BYTES,
  TENANT_USERS,
  collectionsOf,
  fake,
  filesOf,
  indexKey,
  itemsOf,
  objectKeysOutside,
  seedCollection,
  seedFile,
  seedItem,
  seedRole,
} from "@/services/workspace-files/__tests__/fake-supabase";
import {
  WORKSPACE_FILE_MAX_BYTES,
  WORKSPACE_UPLOAD_MAX_REQUEST_BYTES,
  WORKSPACE_UPLOAD_MEMORY_BUDGET_BYTES,
  deleteWorkspaceFileCollection,
  deleteWorkspaceFileCollectionFile,
  deleteWorkspaceFileRoute,
  getPublicWorkspaceFile,
  getWorkspaceFiles,
  patchWorkspaceFileCollection,
  postWorkspaceFileCollection,
  postWorkspaceFileCollectionFiles,
  workspaceFilesBodyCap,
  workspaceFilesUploadChain,
  workspaceUploadBytesInFlight,
} from "../workspace-files";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.get("/api/workspace/files", getWorkspaceFiles);
  app.get("/api/public/workspace-files/:tenantId/:fileId/:name", getPublicWorkspaceFile);
  app.post("/api/workspace/files", ...workspaceFilesUploadChain);
  app.delete("/api/workspace/files/:id", deleteWorkspaceFileRoute);
  app.post("/api/workspace/file-collections", postWorkspaceFileCollection);
  app.patch("/api/workspace/file-collections/:id", patchWorkspaceFileCollection);
  app.delete("/api/workspace/file-collections/:id", deleteWorkspaceFileCollection);
  app.post("/api/workspace/file-collections/:id/files", postWorkspaceFileCollectionFiles);
  app.delete("/api/workspace/file-collections/:id/files/:fileId", deleteWorkspaceFileCollectionFile);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

beforeEach(() => {
  fake.reset();
  _resetIndexMemoForTest();
  auth.tenant_id = A;
  for (const t of [A, B, C]) seedRole(t, "user-1", "owner");
});

const PUBLIC_URL_BASE = "https://api.test.zavi";

function storageTouches(): number {
  return fake.state.uploads.length + fake.state.downloads.length + fake.state.removes.length + fake.state.uploadCalls;
}

function indexBytes(t: string): string | undefined {
  return fake.state.objects.get(indexKey(t))?.body.toString("utf8");
}

type Json = Record<string, any>;

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Json | null }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : null };
}

async function upload(
  parts: Array<{ name: string; bytes: Buffer; type: string }>,
  fields: Record<string, string> = {},
  field = "files",
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Json | null }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const p of parts) form.append(field, new Blob([new Uint8Array(p.bytes)], { type: p.type }), p.name);
  const res = await fetch(`${base}/api/workspace/files`, { method: "POST", body: form, headers });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : null };
}

describe("GET /api/workspace/files", () => {
  it("returns the contract shape for the caller's tenant only", async () => {
    const mine = seedFile(A, { name: "hero.png", size: 2048 });
    const theirs = seedFile(B, { name: "secret.png" });
    const col = seedCollection(A, "landing");
    seedCollection(B, "their-landing");
    seedItem(A, col.id, mine.id);

    const res = await call("GET", "/api/workspace/files");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      files: [
        {
          id: mine.id,
          name: "hero.png",
          mime: "image/png",
          size: 2048,
          url: `${PUBLIC_URL_BASE}/api/public/workspace-files/${A}/${mine.id}/seed.png`,
          created_at: mine.created_at,
          collection_ids: [col.id],
        },
      ],
      collections: [{ id: col.id, name: "landing", created_at: col.created_at, file_count: 1 }],
    });
    expect(JSON.stringify(res.body)).not.toContain(theirs.id);
    expect(objectKeysOutside(A)).toEqual([]);
  });

  it("answers an empty workspace with empty lists, not an error", async () => {
    const res = await call("GET", "/api/workspace/files");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ files: [], collections: [] });
  });

  it("answers 401 without touching storage when unauthenticated", async () => {
    auth.tenant_id = null;
    const res = await call("GET", "/api/workspace/files");
    expect(res.status).toBe(401);
    expect(storageTouches()).toBe(0);
  });
});

describe("POST /api/workspace/files", () => {
  it("uploads through real multipart parsing, keeps bytes, and files them into the collection", async () => {
    const col = seedCollection(A, "landing");
    const jpeg = Buffer.concat([BYTES.jpeg, Buffer.alloc(3000, 9)]);
    const res = await upload(
      [
        { name: "hero.jpg", bytes: jpeg, type: "image/jpeg" },
        { name: "badge.webp", bytes: BYTES.webp, type: "image/webp" },
      ],
      { collection_id: col.id },
    );
    expect(res.status).toBe(201);
    const files = res.body!.files as Json[];
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.name)).toEqual(["hero.jpg", "badge.webp"]);
    expect(files.map((f) => f.collection_ids)).toEqual([[col.id], [col.id]]);
    expect(files[0].size).toBe(jpeg.length);
    expect(files[0].url).toBe(`${PUBLIC_URL_BASE}/api/public/workspace-files/${A}/${files[0].id}/hero.jpg`);

    const stored = fake.state.objects.get(`${BUCKET}/${fake.state.uploads[0].path}`)!;
    expect(stored.body.equals(jpeg)).toBe(true);
    expect(stored.contentType).toBe("image/jpeg");
    expect(itemsOf(A)).toHaveLength(2);
    expect(objectKeysOutside(A)).toEqual([]);
  });

  it("serves an uploaded photo back at the url it returned, byte for byte", async () => {
    const jpeg = Buffer.concat([BYTES.jpeg, Buffer.alloc(5000, 3)]);
    const res = await upload([{ name: "Hero Shot.jpg", bytes: jpeg, type: "image/jpeg" }]);
    const url = new URL(res.body!.files[0].url as string);
    const served = await fetch(`${base}${url.pathname}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/jpeg");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await served.arrayBuffer()).equals(jpeg)).toBe(true);
  });

  it("keeps a utf-8 display name intact", async () => {
    const res = await upload([{ name: "café façade.png", bytes: BYTES.png, type: "image/png" }]);
    expect(res.status).toBe(201);
    expect(res.body!.files[0].name).toBe("café façade.png");
    expect(fake.state.uploads[0].path).toMatch(/\/caf-fa-ade\.png$/);
  });

  it("rejects an svg renamed to .png with 415 and stores nothing, even alongside a valid photo", async () => {
    const res = await upload([
      { name: "fine.png", bytes: BYTES.png, type: "image/png" },
      { name: "evil.png", bytes: BYTES.svg, type: "image/png" },
    ]);
    expect(res.status).toBe(415);
    expect(res.body!.error.code).toBe("unsupported_type");
    expect(fake.state.uploads).toEqual([]);
    expect(filesOf(A)).toEqual([]);
  });

  it("rejects a declared svg with 415", async () => {
    const res = await upload([{ name: "logo.svg", bytes: BYTES.svg, type: "image/svg+xml" }]);
    expect(res.status).toBe(415);
    expect(fake.state.uploads).toEqual([]);
  });

  it("rejects a photo over 10MB with 413 before the handler runs", async () => {
    const over = Buffer.concat([BYTES.png, Buffer.alloc(WORKSPACE_FILE_MAX_BYTES)]);
    const res = await upload([{ name: "huge.png", bytes: over, type: "image/png" }]);
    expect(res.status).toBe(413);
    expect(res.body!.error.code).toBe("file_too_large");
    expect(storageTouches()).toBe(0);
  });

  it("rejects more than 20 photos", async () => {
    const parts = Array.from({ length: 21 }, (_, i) => ({ name: `${i}.png`, bytes: BYTES.png, type: "image/png" }));
    const res = await upload(parts);
    expect(res.status).toBe(400);
    expect(res.body!.error.code).toBe("too_many_files");
    expect(fake.state.uploads).toEqual([]);
  });

  it("accepts exactly 20 photos", async () => {
    const parts = Array.from({ length: 20 }, (_, i) => ({ name: `${i}.png`, bytes: BYTES.png, type: "image/png" }));
    const res = await upload(parts);
    expect(res.status).toBe(201);
    expect(res.body!.files).toHaveLength(20);
    expect(filesOf(A)).toHaveLength(20);
  });

  it("rejects a request with no files", async () => {
    const res = await upload([], { collection_id: "" });
    expect(res.status).toBe(400);
    expect(res.body!.error.code).toBe("no_files");
  });

  it("rejects files sent under the wrong field", async () => {
    const res = await upload([{ name: "a.png", bytes: BYTES.png, type: "image/png" }], {}, "file");
    expect(res.status).toBe(400);
    expect(fake.state.uploads).toEqual([]);
  });

  it("leaves no objects and no index entries behind when storage fails midway", async () => {
    fake.state.failUploadOnCall = 2;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await upload([
      { name: "1.png", bytes: BYTES.png, type: "image/png" },
      { name: "2.gif", bytes: BYTES.gif, type: "image/gif" },
      { name: "3.avif", bytes: BYTES.avif, type: "image/avif" },
    ]);
    errors.mockRestore();
    expect(res.status).toBe(502);
    expect(res.body!.error.code).toBe("upload_failed");
    expect(fake.state.objects.size).toBe(0);
    expect(filesOf(A)).toEqual([]);
    expect(fake.state.removes).toEqual([{ bucket: BUCKET, paths: [fake.state.uploads[0].path] }]);
  });

  it("404s another tenant's collection and uploads nothing", async () => {
    const theirs = seedCollection(B, "landing");
    const res = await upload([{ name: "a.png", bytes: BYTES.png, type: "image/png" }], {
      collection_id: theirs.id,
    });
    expect(res.status).toBe(404);
    expect(res.body!.error.code).toBe("collection_not_found");
    expect(fake.state.uploads).toEqual([]);
  });

  it("stops at auth before storing anything", async () => {
    auth.tenant_id = null;
    const res = await upload([{ name: "a.png", bytes: BYTES.png, type: "image/png" }]);
    expect(res.status).toBe(401);
    expect(storageTouches()).toBe(0);
  });

  it("refuses a declared body above the request cap before multer buffers it", () => {
    const status = vi.fn();
    const json = vi.fn();
    const res = { status: status.mockImplementation(() => ({ json })) };
    const next = vi.fn();
    workspaceFilesBodyCap(
      { headers: { "content-length": String(WORKSPACE_UPLOAD_MAX_REQUEST_BYTES + 1) } } as never,
      res as never,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(413);
    workspaceFilesBodyCap({ headers: { "content-length": String(WORKSPACE_UPLOAD_MAX_REQUEST_BYTES) } } as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/public/workspace-files/:tenantId/:fileId/:name", () => {
  it("needs no auth, and 404s once the photo is deleted", async () => {
    const res = await upload([{ name: "a.png", bytes: BYTES.png, type: "image/png" }]);
    const path = new URL(res.body!.files[0].url as string).pathname;
    auth.tenant_id = null;
    expect((await fetch(`${base}${path}`)).status).toBe(200);
    auth.tenant_id = A;
    expect((await call("DELETE", `/api/workspace/files/${res.body!.files[0].id}`)).status).toBe(204);
    const gone = await fetch(`${base}${path}`);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: { code: "file_not_found", message: "No file at that address." } });
  });

  it("never serves the tenant's index or reaches outside its prefix", async () => {
    seedFile(A);
    for (const p of [
      `/api/public/workspace-files/${A}/index.json/x`,
      `/api/public/workspace-files/${A}/..%2Findex.json/x`,
      `/api/public/workspace-files/${A}/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/..%2F..%2Findex.json`,
      `/api/public/workspace-files/not-a-tenant/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/a.png`,
    ]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status, p).toBe(404);
      expect(await res.text()).not.toContain("collections");
    }
    expect(fake.state.downloads.some((d) => d.endsWith("index.json"))).toBe(false);
  });

  it("answers 503 without leaking the storage error", async () => {
    fake.state.failDownload = { message: "connect ECONNREFUSED 10.0.9.9:5432", statusCode: "544" };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await fetch(`${base}/api/public/workspace-files/${A}/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/a.png`);
    errors.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("10.0.9.9");
  });
});

describe("DELETE /api/workspace/files/:id", () => {
  it("404s another tenant's file and never touches its object", async () => {
    const theirs = seedFile(B);
    const res = await call("DELETE", `/api/workspace/files/${theirs.id}`);
    expect(res.status).toBe(404);
    expect(fake.state.removes).toEqual([]);
    expect(filesOf(B)).toHaveLength(1);
    expect(objectKeysOutside(A)).toEqual([]);
  });

  it("404s a malformed id without touching storage", async () => {
    const res = await call("DELETE", "/api/workspace/files/not-a-uuid");
    expect(res.status).toBe(404);
    expect(storageTouches()).toBe(0);
  });

  it("deletes the object, the index entry and its memberships", async () => {
    const mine = seedFile(A);
    const col = seedCollection(A, "landing");
    seedItem(A, col.id, mine.id);
    const res = await call("DELETE", `/api/workspace/files/${mine.id}`);
    expect(res.status).toBe(204);
    expect(fake.state.removes).toEqual([{ bucket: BUCKET, paths: [mine.path] }]);
    expect(fake.state.objects.has(`${BUCKET}/${mine.path}`)).toBe(false);
    expect(filesOf(A)).toEqual([]);
    expect(itemsOf(A)).toEqual([]);
    expect(collectionsOf(A)).toHaveLength(1);
  });
});

describe("collections routes", () => {
  it("creates a collection with the contract shape, in the caller's own index", async () => {
    const res = await call("POST", "/api/workspace/file-collections", { name: "  Landing " });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      collection: { id: expect.any(String), name: "Landing", created_at: expect.any(String), file_count: 0 },
    });
    expect(collectionsOf(A).map((c) => c.id)).toEqual([res.body!.collection.id]);
    expect(collectionsOf(B)).toEqual([]);
  });

  it("409s a duplicate name regardless of case", async () => {
    seedCollection(A, "Landing");
    const res = await call("POST", "/api/workspace/file-collections", { name: "lAnDiNg" });
    expect(res.status).toBe(409);
    expect(res.body!.error.code).toBe("collection_exists");
  });

  it.each([{}, { name: "" }, { name: " " }, { name: "x".repeat(61) }, { name: ["landing"] }])("400s %j", async (body) => {
    const res = await call("POST", "/api/workspace/file-collections", body);
    expect(res.status).toBe(400);
    expect(res.body!.error.code).toBe("bad_name");
  });

  it("renames and validates the new name", async () => {
    const col = seedCollection(A, "landing");
    const ok = await call("PATCH", `/api/workspace/file-collections/${col.id}`, { name: "Home page" });
    expect(ok.status).toBe(200);
    expect(ok.body!.collection).toMatchObject({ id: col.id, name: "Home page", file_count: 0 });
    const bad = await call("PATCH", `/api/workspace/file-collections/${col.id}`, { name: "" });
    expect(bad.status).toBe(400);
  });

  it("404s renaming another tenant's collection and leaves it alone", async () => {
    const theirs = seedCollection(B, "landing");
    const res = await call("PATCH", `/api/workspace/file-collections/${theirs.id}`, { name: "hijacked" });
    expect(res.status).toBe(404);
    expect(collectionsOf(B)[0].name).toBe("landing");
  });

  it("deleting a collection keeps the files", async () => {
    const f = seedFile(A);
    const col = seedCollection(A, "landing");
    seedItem(A, col.id, f.id);
    const res = await call("DELETE", `/api/workspace/file-collections/${col.id}`);
    expect(res.status).toBe(204);
    const list = await call("GET", "/api/workspace/files");
    expect(list.body!.files.map((x: Json) => x.id)).toEqual([f.id]);
    expect(list.body!.files[0].collection_ids).toEqual([]);
    expect(list.body!.collections).toEqual([]);
    expect(fake.state.removes).toEqual([]);
  });

  it("404s deleting another tenant's collection", async () => {
    const theirs = seedCollection(B, "landing");
    const res = await call("DELETE", `/api/workspace/file-collections/${theirs.id}`);
    expect(res.status).toBe(404);
    expect(collectionsOf(B)).toHaveLength(1);
  });
});

describe("collection membership routes", () => {
  it("adding is idempotent", async () => {
    const col = seedCollection(A, "landing");
    const f = seedFile(A);
    const first = await call("POST", `/api/workspace/file-collections/${col.id}/files`, { file_ids: [f.id] });
    const second = await call("POST", `/api/workspace/file-collections/${col.id}/files`, { file_ids: [f.id, f.id] });
    expect([first.status, second.status]).toEqual([204, 204]);
    expect(itemsOf(A)).toHaveLength(1);
    const list = await call("GET", "/api/workspace/files");
    expect(list.body!.collections[0].file_count).toBe(1);
  });

  it("404s when a file id belongs to another tenant and adds none", async () => {
    const col = seedCollection(A, "landing");
    const mine = seedFile(A);
    const theirs = seedFile(B);
    const res = await call("POST", `/api/workspace/file-collections/${col.id}/files`, { file_ids: [mine.id, theirs.id] });
    expect(res.status).toBe(404);
    expect(itemsOf(A)).toEqual([]);
  });

  it("404s adding into another tenant's collection", async () => {
    const theirs = seedCollection(B, "landing");
    const mine = seedFile(A);
    const res = await call("POST", `/api/workspace/file-collections/${theirs.id}/files`, { file_ids: [mine.id] });
    expect(res.status).toBe(404);
    expect(itemsOf(B)).toEqual([]);
  });

  it("400s a bad file_ids body", async () => {
    const col = seedCollection(A, "landing");
    for (const body of [{}, { file_ids: [] }, { file_ids: ["x"] }, { file_ids: "abc" }]) {
      const res = await call("POST", `/api/workspace/file-collections/${col.id}/files`, body);
      expect(res.status).toBe(400);
      expect(res.body!.error.code).toBe("bad_file_ids");
    }
  });

  it("removes one membership", async () => {
    const col = seedCollection(A, "landing");
    const f = seedFile(A);
    seedItem(A, col.id, f.id);
    const res = await call("DELETE", `/api/workspace/file-collections/${col.id}/files/${f.id}`);
    expect(res.status).toBe(204);
    expect(itemsOf(A)).toEqual([]);
    expect(filesOf(A)).toHaveLength(1);
  });

  it("404s removing a membership from another tenant's collection", async () => {
    const col = seedCollection(B, "landing");
    const f = seedFile(B);
    seedItem(B, col.id, f.id);
    const res = await call("DELETE", `/api/workspace/file-collections/${col.id}/files/${f.id}`);
    expect(res.status).toBe(404);
    expect(itemsOf(B)).toHaveLength(1);
  });
});

describe("write routes require owner or admin", () => {
  const MEMBER = { "x-test-user": "member-1" };

  it("refuses a member on every write route and leaves the index and objects untouched", async () => {
    seedRole(A, "member-1", "member");
    const f = seedFile(A);
    const col = seedCollection(A, "landing");
    seedItem(A, col.id, f.id);
    const before = indexBytes(A);
    const objectsBefore = [...fake.state.objects.keys()];

    const attempts = [
      await upload([{ name: "a.png", bytes: BYTES.png, type: "image/png" }], { collection_id: col.id }, "files", MEMBER),
      await call("DELETE", `/api/workspace/files/${f.id}`, undefined, MEMBER),
      await call("POST", "/api/workspace/file-collections", { name: "new one" }, MEMBER),
      await call("PATCH", `/api/workspace/file-collections/${col.id}`, { name: "renamed" }, MEMBER),
      await call("DELETE", `/api/workspace/file-collections/${col.id}`, undefined, MEMBER),
      await call("POST", `/api/workspace/file-collections/${col.id}/files`, { file_ids: [f.id] }, MEMBER),
      await call("DELETE", `/api/workspace/file-collections/${col.id}/files/${f.id}`, undefined, MEMBER),
    ];

    expect(attempts.map((r) => [r.status, r.body?.error?.code])).toEqual(Array(7).fill([403, "forbidden"]));
    expect(indexBytes(A)).toBe(before);
    expect([...fake.state.objects.keys()]).toEqual(objectsBefore);
    expect(storageTouches()).toBe(0);
    expect(workspaceUploadBytesInFlight()).toBe(0);
  });

  it("refuses a caller with no role row at all", async () => {
    const f = seedFile(A);
    const res = await call("DELETE", `/api/workspace/files/${f.id}`, undefined, { "x-test-user": "ghost" });
    expect(res.status).toBe(403);
    expect(filesOf(A)).toHaveLength(1);
    expect(fake.state.removes).toEqual([]);
  });

  it("does not let a member's owner role in another tenant unlock this one", async () => {
    seedRole(B, "member-1", "owner");
    seedRole(A, "member-1", "member");
    const res = await call("POST", "/api/workspace/file-collections", { name: "x" }, MEMBER);
    expect(res.status).toBe(403);
    expect(collectionsOf(A)).toEqual([]);
  });

  it("lets an admin write and a member read", async () => {
    seedRole(A, "admin-1", "admin");
    seedRole(A, "member-1", "member");
    const created = await call("POST", "/api/workspace/file-collections", { name: "landing" }, { "x-test-user": "admin-1" });
    expect(created.status).toBe(201);
    const listed = await call("GET", "/api/workspace/files", undefined, MEMBER);
    expect(listed.status).toBe(200);
    expect(listed.body!.collections.map((c: Json) => c.name)).toEqual(["landing"]);
  });

  it("answers a role lookup failure with a generic 500 and writes nothing", async () => {
    fake.state.failNext.push({ table: TENANT_USERS, op: "select", message: "connection to 10.0.3.7 refused" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await call("POST", "/api/workspace/file-collections", { name: "landing" });
    errors.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("10.0.3.7");
    expect(collectionsOf(A)).toEqual([]);
  });
});

describe("storage errors never reach the client", () => {
  it("returns a stable code and a generic message on a read, and logs the raw error", async () => {
    const raw = 'permission denied for bucket "internal_billing_ledger"';
    fake.state.failDownload = { message: raw, statusCode: "403" };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await call("GET", "/api/workspace/files");
    const logged = errors.mock.calls.map((c) => c.join(" ")).join("\n");
    errors.mockRestore();
    expect(res.status).toBe(503);
    expect(res.body!.error.code).toBe("files_unavailable");
    expect(JSON.stringify(res.body)).not.toContain("internal_billing_ledger");
    expect(logged).toContain(raw);
  });

  it("hides the raw error on a write path too", async () => {
    const col = seedCollection(A, "landing");
    fake.state.failIndexWrite = { message: "deadlock detected on tuple (0,42) of pg_catalog" };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await call("DELETE", `/api/workspace/file-collections/${col.id}`);
    errors.mockRestore();
    expect(res.status).toBe(503);
    expect(res.body!.error.code).toBe("files_unavailable");
    expect(JSON.stringify(res.body)).not.toContain("pg_catalog");
    expect(collectionsOf(A)).toHaveLength(1);
  });
});

describe("process-wide upload memory budget", () => {
  const MiB = 1024 * 1024;

  type Held = { req: ClientRequest; response: Promise<{ status: number; body: Json | null }> };

  function hold(tenant: string, declared: number): Held {
    const url = new URL(`${base}/api/workspace/files`);
    let resolveResponse!: (v: { status: number; body: Json | null }) => void;
    const response = new Promise<{ status: number; body: Json | null }>((r) => {
      resolveResponse = r;
    });
    const req = httpRequest({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      agent: false,
      headers: {
        "content-type": "multipart/form-data; boundary=zz",
        "content-length": String(declared),
        "x-test-tenant": tenant,
      },
    });
    req.on("error", () => undefined);
    req.on("response", (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolveResponse({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as Json) : null }));
    });
    req.write(
      '--zz\r\nContent-Disposition: form-data; name="files"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n',
    );
    req.write(BYTES.png);
    return { req, response };
  }

  async function until(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; in flight ${workspaceUploadBytesInFlight()}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  function settled(p: Promise<unknown>): Promise<boolean> {
    return Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 150))]);
  }

  it("refuses a third tenant once two others hold the budget, and frees it when one disconnects", async () => {
    expect(WORKSPACE_UPLOAD_MEMORY_BUDGET_BYTES).toBe(400 * MiB);
    const a = hold(A, 150 * MiB);
    await until(() => workspaceUploadBytesInFlight() === 150 * MiB, "A reserved");
    const b = hold(B, 150 * MiB);
    await until(() => workspaceUploadBytesInFlight() === 300 * MiB, "B reserved");

    const c = hold(C, 150 * MiB);
    const refused = await c.response;
    expect(refused.status).toBe(503);
    expect(refused.body!.error.code).toBe("upload_capacity_busy");
    c.req.destroy();
    expect(workspaceUploadBytesInFlight()).toBe(300 * MiB);

    a.req.destroy();
    await until(() => workspaceUploadBytesInFlight() === 150 * MiB, "A released on disconnect");

    const c2 = hold(C, 150 * MiB);
    await until(() => workspaceUploadBytesInFlight() === 300 * MiB, "C admitted");
    expect(await settled(c2.response)).toBe(false);

    b.req.destroy();
    c2.req.destroy();
    await until(() => workspaceUploadBytesInFlight() === 0, "all released");
    expect(fake.state.uploadCalls).toBe(0);
    expect(filesOf(A)).toEqual([]);
  });

  it("releases the reservation after every kind of failed upload", async () => {
    const col = seedCollection(B, "theirs");
    const outcomes = [
      await upload([{ name: "x.png", bytes: BYTES.svg, type: "image/png" }]),
      await upload([{ name: "big.png", bytes: Buffer.concat([BYTES.png, Buffer.alloc(WORKSPACE_FILE_MAX_BYTES)]), type: "image/png" }]),
      await upload([{ name: "a.png", bytes: BYTES.png, type: "image/png" }], { collection_id: col.id }),
      await upload([{ name: "a.png", bytes: BYTES.png, type: "image/png" }], {}, "wrong"),
    ];
    fake.state.failUploadOnCall = 1;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    outcomes.push(await upload([{ name: "a.png", bytes: BYTES.png, type: "image/png" }]));
    errors.mockRestore();
    expect(outcomes.map((o) => o.status)).toEqual([415, 413, 404, 400, 502]);
    expect(workspaceUploadBytesInFlight()).toBe(0);

    const a = hold(A, 200 * MiB);
    const b = hold(B, 200 * MiB);
    await until(() => workspaceUploadBytesInFlight() === 400 * MiB, "full budget usable again");
    expect(await settled(a.response)).toBe(false);
    expect(await settled(b.response)).toBe(false);
    a.req.destroy();
    b.req.destroy();
    await until(() => workspaceUploadBytesInFlight() === 0, "all released");
  });

  it("reserves the whole request cap for a body with no declared length", async () => {
    const a = hold(A, 150 * MiB);
    await until(() => workspaceUploadBytesInFlight() === 150 * MiB, "A reserved");
    const url = new URL(`${base}/api/workspace/files`);
    const chunked = httpRequest({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      agent: false,
      headers: { "content-type": "multipart/form-data; boundary=zz", "transfer-encoding": "chunked", "x-test-tenant": B },
    });
    chunked.on("error", () => undefined);
    const status = new Promise<number>((r) => chunked.on("response", (res) => r(res.statusCode ?? 0)));
    chunked.write("--zz\r\n");
    await until(() => workspaceUploadBytesInFlight() === 150 * MiB + WORKSPACE_UPLOAD_MAX_REQUEST_BYTES, "chunked reserved");
    const c = hold(C, 100 * MiB);
    expect((await c.response).status).toBe(503);
    c.req.destroy();
    chunked.destroy();
    a.req.destroy();
    await until(() => workspaceUploadBytesInFlight() === 0, "all released");
    expect(await settled(status)).toBe(false);
  });
});
