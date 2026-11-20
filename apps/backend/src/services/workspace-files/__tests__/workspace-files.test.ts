import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", async () => {
  const { fake } = await import("./fake-supabase");
  return { serviceClient: () => fake.client() };
});

import { _resetIndexMemoForTest } from "../workspace-files";
import {
  BUCKET,
  BYTES,
  PUBLIC_BASE,
  collectionsOf,
  fake,
  filesOf,
  indexKey,
  itemsOf,
  objectKeysOutside,
  readIndexOf,
  seedCollection,
  seedFile,
  seedItem,
  seedRawIndex,
} from "./fake-supabase";
import { sanitizeFileName, sniffImageMime, normalizeDeclaredMime } from "../sniff";
import {
  WORKSPACE_FILES_TOTAL_MAX,
  WORKSPACE_FILE_MAX_BYTES,
  WorkspaceFilesError,
  addFilesToCollection,
  createCollection,
  deleteCollection,
  deleteWorkspaceFile,
  listWorkspaceFiles,
  readPublicWorkspaceFile,
  removeFileFromCollection,
  renameCollection,
  uploadWorkspaceFiles,
  workspaceFilesDeps,
  type IncomingFile,
  type WorkspaceFilesDeps,
} from "../workspace-files";
import { asTenantId } from "@/services/tenant-client";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const deps = (t: string): WorkspaceFilesDeps => ({ ...workspaceFilesDeps(asTenantId(t)), publicBase: PUBLIC_BASE });
const depsA = () => deps(A);
const depsB = () => deps(B);

function file(name: string, body: Buffer, mimetype: string): IncomingFile {
  return { originalname: name, mimetype, size: body.length, buffer: body };
}

async function expectError(p: Promise<unknown>, status: number, code: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected ${status} ${code}`).toBeInstanceOf(WorkspaceFilesError);
  expect((err as WorkspaceFilesError).status).toBe(status);
  expect((err as WorkspaceFilesError).code).toBe(code);
}

function indexBytes(t: string): string | undefined {
  return fake.state.objects.get(indexKey(t))?.body.toString("utf8");
}

function fileObjects(): string[] {
  return [...fake.state.objects.keys()].filter((k) => !k.endsWith("/index.json"));
}

function quiet() {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

beforeEach(() => {
  fake.reset();
  _resetIndexMemoForTest();
});

describe("sniffImageMime", () => {
  it.each([
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
    ["avif", "image/avif"],
    ["avifCompat", "image/avif"],
  ] as const)("recognises %s by its bytes", (key, mime) => {
    expect(sniffImageMime(BYTES[key])).toBe(mime);
  });

  it.each([
    ["svg", BYTES.svg],
    ["heic", BYTES.heic],
    ["html", Buffer.from("<!doctype html><script>x</script>")],
    ["wav riff", Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WAVEfmt ")])],
    ["png signature cut short", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ["png without the dos/unix line-ending probe", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x0a, 0x0a, 1, 2])],
    ["gif7 lookalike", Buffer.from("GIF7xxxxx")],
    ["empty", Buffer.alloc(0)],
    ["mp4", Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(12)])],
  ])("rejects %s", (_label, buf) => {
    expect(sniffImageMime(buf)).toBeNull();
  });

  it("does not accept svg under any declared type", () => {
    expect(normalizeDeclaredMime("image/svg+xml")).toBeNull();
    expect(normalizeDeclaredMime("constructor")).toBeNull();
    expect(normalizeDeclaredMime("IMAGE/JPG; charset=binary")).toBe("image/jpeg");
  });
});

describe("sanitizeFileName", () => {
  it("keeps safe characters and the extension", () => {
    expect(sanitizeFileName("My Photo (1).PNG", "image/png")).toBe("My-Photo-1.png");
  });

  it("drops directory parts and dot runs so a path cannot climb", () => {
    expect(sanitizeFileName("../../etc/passwd", "image/png")).toBe("passwd.png");
    expect(sanitizeFileName("..\\..\\a..b.jpg", "image/jpeg")).toBe("a.b.jpg");
    expect(sanitizeFileName("....", "image/gif")).toBe("image.gif");
  });

  it("falls back to a readable name for non-latin names and adds a missing extension", () => {
    expect(sanitizeFileName("日本語.webp", "image/webp")).toBe("image.webp");
    expect(sanitizeFileName("hero", "image/jpeg")).toBe("hero.jpg");
  });

  it("caps the stored name at 100 characters and keeps the extension", () => {
    const out = sanitizeFileName(`${"x".repeat(400)}.jpeg`, "image/jpeg");
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith(".jpeg")).toBe(true);
    expect(out).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe("uploadWorkspaceFiles", () => {
  it("stores the original bytes under the tenant's prefix, records them in the index and returns stable urls", async () => {
    const big = Buffer.concat([BYTES.jpeg, Buffer.alloc(4096, 7)]);
    const rows = await uploadWorkspaceFiles(depsA(), {
      files: [file("Hero Shot.JPG", big, "image/jpeg"), file("logo.png", BYTES.png, "image/png")],
      uploadedBy: "user-1",
    });

    expect(rows).toHaveLength(2);
    const photoUploads = fake.state.uploads.filter((u) => !u.path.endsWith("/index.json"));
    expect(photoUploads).toHaveLength(2);
    for (const up of photoUploads) {
      expect(up.bucket).toBe(BUCKET);
      expect(up.upsert).toBe(false);
      expect(up.path).toMatch(new RegExp(`^${A}/workspace-files/[0-9a-f-]{36}/[A-Za-z0-9._-]+$`));
    }
    const hero = photoUploads[0];
    expect(hero.path.endsWith("/Hero-Shot.jpg")).toBe(true);
    expect(hero.contentType).toBe("image/jpeg");
    expect(fake.state.objects.get(`${BUCKET}/${hero.path}`)!.body.equals(big)).toBe(true);

    expect(rows[0]).toEqual({
      id: hero.path.split("/")[2],
      name: "Hero Shot.JPG",
      mime: "image/jpeg",
      size: big.length,
      url: `${PUBLIC_BASE}/api/public/workspace-files/${A}/${hero.path.split("/")[2]}/Hero-Shot.jpg`,
      created_at: expect.any(String),
      collection_ids: [],
    });
    expect(filesOf(A).map((f) => f.uploaded_by)).toEqual(["user-1", "user-1"]);
    expect(filesOf(A).map((f) => f.path)).toEqual(photoUploads.map((u) => u.path));
    expect(objectKeysOutside(A)).toEqual([]);
  });

  it("rejects an svg disguised as a png before reading or writing anything", async () => {
    await expectError(
      uploadWorkspaceFiles(depsA(), {
        files: [file("ok.png", BYTES.png, "image/png"), file("evil.png", BYTES.svg, "image/png")],
      }),
      415,
      "unsupported_type",
    );
    expect(fake.state.uploads).toEqual([]);
    expect(fake.state.downloads).toEqual([]);
  });

  it("rejects a real png whose declared type is not an allowed image", async () => {
    await expectError(
      uploadWorkspaceFiles(depsA(), { files: [file("a.png", BYTES.png, "image/svg+xml")] }),
      415,
      "unsupported_type",
    );
    expect(fake.state.uploads).toEqual([]);
  });

  it("rejects a file one byte over the cap with 413 and stores nothing", async () => {
    const over = Buffer.concat([BYTES.png, Buffer.alloc(WORKSPACE_FILE_MAX_BYTES - BYTES.png.length + 1)]);
    await expectError(
      uploadWorkspaceFiles(depsA(), { files: [file("small.png", BYTES.png, "image/png"), file("big.png", over, "image/png")] }),
      413,
      "file_too_large",
    );
    expect(fake.state.uploads).toEqual([]);
  });

  it("accepts a file exactly at the cap", async () => {
    const exact = Buffer.concat([BYTES.png, Buffer.alloc(WORKSPACE_FILE_MAX_BYTES - BYTES.png.length)]);
    const rows = await uploadWorkspaceFiles(depsA(), { files: [file("exact.png", exact, "image/png")] });
    expect(rows[0].size).toBe(WORKSPACE_FILE_MAX_BYTES);
  });

  it("rolls back every photo already stored when a later one fails, and never writes the index", async () => {
    const before = seedFile(A);
    const snapshot = indexBytes(A);
    fake.state.failUploadOnCall = 3;
    const errors = quiet();
    await expectError(
      uploadWorkspaceFiles(depsA(), {
        files: [
          file("1.png", BYTES.png, "image/png"),
          file("2.gif", BYTES.gif, "image/gif"),
          file("3.webp", BYTES.webp, "image/webp"),
          file("4.jpg", BYTES.jpeg, "image/jpeg"),
        ],
      }),
      502,
      "upload_failed",
    );
    errors.mockRestore();
    expect(fake.state.uploadCalls).toBe(3);
    const stored = fake.state.uploads.map((u) => u.path);
    expect(stored).toHaveLength(2);
    expect(fake.state.removes).toEqual([{ bucket: BUCKET, paths: stored }]);
    expect(fileObjects()).toEqual([`${BUCKET}/${before.path}`]);
    expect(indexBytes(A)).toBe(snapshot);
  });

  it.each([
    ["returns an error", { message: "gateway timeout" }],
    ["throws", "throw"],
  ] as const)("removes every stored photo when the index write %s, and leaves the old index intact", async (_l, failure) => {
    const before = seedFile(A);
    const snapshot = indexBytes(A);
    fake.state.failIndexWrite = failure;
    const errors = quiet();
    await expectError(
      uploadWorkspaceFiles(depsA(), { files: [file("1.png", BYTES.png, "image/png"), file("2.gif", BYTES.gif, "image/gif")] }),
      503,
      "files_unavailable",
    );
    errors.mockRestore();
    expect(fake.state.removes[0].paths).toHaveLength(2);
    expect(fileObjects()).toEqual([`${BUCKET}/${before.path}`]);
    expect(indexBytes(A)).toBe(snapshot);
  });

  it("files every uploaded photo into the chosen collection", async () => {
    const col = seedCollection(A, "landing");
    const rows = await uploadWorkspaceFiles(depsA(), {
      files: [file("1.png", BYTES.png, "image/png"), file("2.avif", BYTES.avif, "image/avif")],
      collectionId: col.id,
    });
    expect(rows.map((r) => r.collection_ids)).toEqual([[col.id], [col.id]]);
    expect(itemsOf(A)).toEqual(rows.map((r) => ({ collection_id: col.id, file_id: r.id })));
  });

  it("refuses another tenant's collection before storing a photo, and never opens their index", async () => {
    const theirs = seedCollection(B, "landing");
    await expectError(
      uploadWorkspaceFiles(depsA(), { files: [file("1.png", BYTES.png, "image/png")], collectionId: theirs.id }),
      404,
      "collection_not_found",
    );
    expect(fake.state.uploads).toEqual([]);
    expect(objectKeysOutside(A)).toEqual([]);
    expect(collectionsOf(B)[0].file_ids).toEqual([]);
  });

  it("refuses a malformed collection id without storing anything", async () => {
    await expectError(
      uploadWorkspaceFiles(depsA(), { files: [file("1.png", BYTES.png, "image/png")], collectionId: "x' or 1=1" }),
      404,
      "collection_not_found",
    );
    expect(fake.state.uploads).toEqual([]);
  });

  it("refuses a batch that would pass the workspace limit, and takes one that lands exactly on it", async () => {
    const files = Array.from({ length: WORKSPACE_FILES_TOTAL_MAX - 1 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      name: "x.png",
      mime: "image/png",
      size: 1,
      path: `${A}/workspace-files/00000000-0000-4000-8000-${String(i).padStart(12, "0")}/x.png`,
      created_at: "2026-09-01T00:00:00.000Z",
      uploaded_by: null,
    }));
    seedRawIndex(A, JSON.stringify({ version: 1, files, collections: [] }));

    await expectError(
      uploadWorkspaceFiles(depsA(), { files: [file("1.png", BYTES.png, "image/png"), file("2.png", BYTES.png, "image/png")] }),
      409,
      "files_limit",
    );
    expect(fake.state.uploads).toEqual([]);

    await uploadWorkspaceFiles(depsA(), { files: [file("1.png", BYTES.png, "image/png")] });
    expect(filesOf(A)).toHaveLength(WORKSPACE_FILES_TOTAL_MAX);
  });
});

describe("uploadWorkspaceFiles with an origin", () => {
  beforeEach(() => {
    fake.reset();
    _resetIndexMemoForTest();
  });

  it("stores the origin on the file and returns the existing row instead of a duplicate on a replay", async () => {
    const origin = "run_artifact:art-1";
    const first = await uploadWorkspaceFiles(depsA(), { files: [file("hero.png", BYTES.png, "image/png")], origin });
    const again = await uploadWorkspaceFiles(depsA(), { files: [file("hero.png", BYTES.png, "image/png")], origin });
    expect(again.map((f) => f.id)).toEqual(first.map((f) => f.id));
    expect(filesOf(A)).toHaveLength(1);
    expect(filesOf(A)[0]).toMatchObject({ origin });
    expect(fileObjects().filter((k) => k.includes(`/${A}/`))).toHaveLength(1);
  });

  it("does not collapse two different origins, nor an origin-less upload of the same bytes", async () => {
    await uploadWorkspaceFiles(depsA(), { files: [file("hero.png", BYTES.png, "image/png")], origin: "run_artifact:art-1" });
    await uploadWorkspaceFiles(depsA(), { files: [file("hero.png", BYTES.png, "image/png")], origin: "run_artifact:art-2" });
    await uploadWorkspaceFiles(depsA(), { files: [file("hero.png", BYTES.png, "image/png")] });
    expect(filesOf(A)).toHaveLength(3);
    expect(filesOf(A).filter((f) => f.origin === undefined)).toHaveLength(1);
  });

  it("keeps origins tenant-scoped", async () => {
    await uploadWorkspaceFiles(depsA(), { files: [file("hero.png", BYTES.png, "image/png")], origin: "run_artifact:art-1" });
    await uploadWorkspaceFiles(depsB(), { files: [file("hero.png", BYTES.png, "image/png")], origin: "run_artifact:art-1" });
    expect(filesOf(A)).toHaveLength(1);
    expect(filesOf(B)).toHaveLength(1);
  });
});

describe("the index is read-modify-write, so reads must never fail open", () => {
  it("treats a tenant with no index yet as empty and writes nothing on a read", async () => {
    expect(await listWorkspaceFiles(depsA())).toEqual({ files: [], collections: [] });
    expect(fake.state.uploads).toEqual([]);
  });

  it.each([
    ["a storage timeout", { message: "The connection to the database timed out", statusCode: "544" }],
    ["a thrown network error", "throw"],
  ] as const)("reports %s as 503 and never overwrites the existing index", async (_l, failure) => {
    const kept = seedFile(A);
    seedCollection(A, "landing");
    const snapshot = indexBytes(A);
    fake.state.failDownload = failure;
    const errors = quiet();

    await expectError(listWorkspaceFiles(depsA()), 503, "files_unavailable");
    await expectError(createCollection(depsA(), "blog"), 503, "files_unavailable");
    await expectError(
      uploadWorkspaceFiles(depsA(), { files: [file("1.png", BYTES.png, "image/png")] }),
      503,
      "files_unavailable",
    );
    await expectError(deleteWorkspaceFile(depsA(), kept.id), 503, "files_unavailable");
    errors.mockRestore();

    expect(indexBytes(A)).toBe(snapshot);
    expect(fake.state.uploads).toEqual([]);
    expect(fake.state.removes).toEqual([]);
  });

  it("refuses to read or write over an index it cannot parse", async () => {
    seedRawIndex(A, '{"version":1,"files":[{"id":"x"}');
    const snapshot = indexBytes(A);
    const errors = quiet();
    await expectError(listWorkspaceFiles(depsA()), 500, "files_index_corrupt");
    await expectError(createCollection(depsA(), "landing"), 500, "files_index_corrupt");
    errors.mockRestore();
    expect(indexBytes(A)).toBe(snapshot);
  });

  it("does not lose writes when many requests for one tenant land at once", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `col-${i}`);
    const photos = Array.from({ length: 5 }, (_, i) => file(`${i}.png`, BYTES.png, "image/png"));
    await Promise.all([
      ...names.map((n) => createCollection(depsA(), n)),
      ...photos.map((p) => uploadWorkspaceFiles(depsA(), { files: [p] })),
    ]);
    expect(collectionsOf(A).map((c) => c.name).sort()).toEqual([...names].sort());
    expect(filesOf(A)).toHaveLength(5);
  });

  it("keeps serving the next request after one fails inside the lock", async () => {
    const errors = quiet();
    fake.state.failIndexWrite = { message: "boom" };
    await expectError(createCollection(depsA(), "one"), 503, "files_unavailable");
    fake.state.failIndexWrite = null;
    errors.mockRestore();
    await createCollection(depsA(), "two");
    expect(collectionsOf(A).map((c) => c.name)).toEqual(["two"]);
  });

  it("lets two tenants write at the same time without touching each other's index", async () => {
    await Promise.all([createCollection(depsA(), "landing"), createCollection(depsB(), "landing")]);
    expect(collectionsOf(A)).toHaveLength(1);
    expect(collectionsOf(B)).toHaveLength(1);
    expect(collectionsOf(A)[0].id).not.toBe(collectionsOf(B)[0].id);
  });
});

describe("listWorkspaceFiles", () => {
  it("returns only the tenant's files newest first and collections by name with counts", async () => {
    const older = seedFile(A, { name: "older.png" });
    const newer = seedFile(A, { name: "newer.png" });
    const foreign = seedFile(B, { name: "foreign.png" });
    const zeta = seedCollection(A, "zeta");
    const alpha = seedCollection(A, "Alpha");
    const theirs = seedCollection(B, "aaa");
    seedItem(A, alpha.id, newer.id);
    seedItem(A, zeta.id, newer.id);
    seedItem(B, theirs.id, foreign.id);

    const out = await listWorkspaceFiles(depsA());
    expect(out.files.map((f) => f.id)).toEqual([newer.id, older.id]);
    expect(out.files[0].collection_ids).toEqual([alpha.id, zeta.id]);
    expect(out.files[1].collection_ids).toEqual([]);
    expect(out.files[0].url).toBe(`${PUBLIC_BASE}/api/public/workspace-files/${A}/${newer.id}/seed.png`);
    expect(out.collections).toEqual([
      { id: alpha.id, name: "Alpha", created_at: alpha.created_at, file_count: 1 },
      { id: zeta.id, name: "zeta", created_at: zeta.created_at, file_count: 1 },
    ]);
    expect(JSON.stringify(out)).not.toContain(foreign.id);
    expect(JSON.stringify(out)).not.toContain(theirs.id);
    expect(objectKeysOutside(A)).toEqual([]);
  });

  it("does not count a membership that points at a file no longer in the index", async () => {
    const col = seedCollection(A, "landing");
    const f = seedFile(A);
    seedItem(A, col.id, f.id);
    seedItem(A, col.id, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    const out = await listWorkspaceFiles(depsA());
    expect(out.collections[0].file_count).toBe(1);
  });

  it("escapes the stored name in the url", async () => {
    const f = seedFile(A, { path: `${A}/workspace-files/dddddddd-dddd-4ddd-8ddd-dddddddddddd/a b#c.png`, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
    const out = await listWorkspaceFiles(depsA());
    expect(out.files[0].url).toBe(`${PUBLIC_BASE}/api/public/workspace-files/${A}/${f.id}/a%20b%23c.png`);
  });
});

describe("deleteWorkspaceFile", () => {
  it("never deletes another tenant's file or its object", async () => {
    const theirs = seedFile(B);
    await expectError(deleteWorkspaceFile(depsA(), theirs.id), 404, "file_not_found");
    expect(fake.state.removes).toEqual([]);
    expect(filesOf(B)).toHaveLength(1);
    expect(fake.state.objects.has(`${BUCKET}/${theirs.path}`)).toBe(true);
    expect(objectKeysOutside(A)).toEqual([]);
  });

  it("never removes an object outside the tenant's prefix even if its own index claims it", async () => {
    const victim = seedFile(B);
    const tampered = seedFile(A, { path: victim.path });
    const errors = quiet();
    await deleteWorkspaceFile(depsA(), tampered.id);
    errors.mockRestore();
    expect(fake.state.removes).toEqual([]);
    expect(fake.state.objects.has(`${BUCKET}/${victim.path}`)).toBe(true);
    expect(filesOf(B).map((f) => f.id)).toEqual([victim.id]);
  });

  it("removes the object, then drops the file and its memberships from the index", async () => {
    const mine = seedFile(A);
    const keep = seedFile(A);
    const col = seedCollection(A, "landing");
    seedItem(A, col.id, mine.id);
    seedItem(A, col.id, keep.id);

    const order: string[] = [];
    fake.state.beforeIndexWrite = () => {
      order.push("index");
    };
    const bucket = fake.client().storage.from(BUCKET);
    const d = {
      ...depsA(),
      storage: {
        from: () => ({
          ...bucket,
          remove: async (paths: string[]) => {
            order.push("object");
            return bucket.remove(paths);
          },
        }),
      },
    } as unknown as WorkspaceFilesDeps;

    await deleteWorkspaceFile(d, mine.id.toUpperCase());
    expect(order).toEqual(["object", "index"]);
    expect(fake.state.removes).toEqual([{ bucket: BUCKET, paths: [mine.path] }]);
    expect(filesOf(A).map((f) => f.id)).toEqual([keep.id]);
    expect(itemsOf(A)).toEqual([{ collection_id: col.id, file_id: keep.id }]);
  });

  it("keeps the file listed when the index write fails, so a retry finishes the delete", async () => {
    const mine = seedFile(A);
    const col = seedCollection(A, "landing");
    seedItem(A, col.id, mine.id);
    const snapshot = indexBytes(A);
    fake.state.failIndexWrite = { message: "timeout" };
    const errors = quiet();
    await expectError(deleteWorkspaceFile(depsA(), mine.id), 503, "files_unavailable");
    expect(fake.state.objects.has(`${BUCKET}/${mine.path}`)).toBe(false);
    expect(indexBytes(A)).toBe(snapshot);
    fake.state.failIndexWrite = null;
    await deleteWorkspaceFile(depsA(), mine.id);
    errors.mockRestore();
    expect(filesOf(A)).toEqual([]);
  });

  it.each([
    ["returns an error", { message: "storage down" }],
    ["throws", "throw"],
  ] as const)("fails and keeps the file listed when the object remove %s (its public link still serves it)", async (_label, failure) => {
    const mine = seedFile(A);
    const keep = seedFile(A);
    const snapshot = indexBytes(A);
    fake.state.failRemove = failure;
    const errors = quiet();
    await expectError(deleteWorkspaceFile(depsA(), mine.id), 503, "files_unavailable");
    errors.mockRestore();
    expect(indexBytes(A)).toBe(snapshot);
    const listed = await listWorkspaceFiles(depsA());
    expect(listed.files.map((f) => f.id).sort()).toEqual([mine.id, keep.id].sort());
  });

  it("404s a malformed id without reading storage", async () => {
    await expectError(deleteWorkspaceFile(depsA(), "../index.json"), 404, "file_not_found");
    expect(fake.state.downloads).toEqual([]);
  });
});

describe("collections", () => {
  it("trims and creates, and rejects duplicates case-insensitively within a tenant only", async () => {
    const created = await createCollection(depsA(), "  Landing  ");
    expect(created).toEqual({ id: expect.any(String), name: "Landing", created_at: expect.any(String), file_count: 0 });
    await expectError(createCollection(depsA(), "LANDING"), 409, "collection_exists");
    await expectError(createCollection(depsA(), " landing"), 409, "collection_exists");
    const theirs = await createCollection(depsB(), "landing");
    expect(theirs.name).toBe("landing");
    expect(collectionsOf(A)).toHaveLength(1);
    expect(collectionsOf(B)).toHaveLength(1);
  });

  it("lets only one of two racing creates with the same name win", async () => {
    const results = await Promise.allSettled([createCollection(depsA(), "Landing"), createCollection(depsA(), "landing")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, code: "collection_exists" });
    expect(collectionsOf(A)).toHaveLength(1);
  });

  it.each(["", "   ", "x".repeat(61), 42, null])("rejects the name %j without touching storage", async (name) => {
    await expectError(createCollection(depsA(), name), 400, "bad_name");
    expect(fake.state.downloads).toEqual([]);
    expect(fake.state.uploads).toEqual([]);
  });

  it("counts characters, not bytes, for the 60 limit", async () => {
    const created = await createCollection(depsA(), "é".repeat(60));
    expect(created.name).toBe("é".repeat(60));
  });

  it("renames, allows a case-only change of its own name, and blocks another collection's name", async () => {
    const landing = seedCollection(A, "landing");
    seedCollection(A, "blog");
    const f = seedFile(A);
    seedItem(A, landing.id, f.id);

    const renamed = await renameCollection(depsA(), landing.id, "LANDING");
    expect(renamed).toMatchObject({ id: landing.id, name: "LANDING", file_count: 1 });
    await expectError(renameCollection(depsA(), landing.id, "Blog"), 409, "collection_exists");
    expect(collectionsOf(A).find((c) => c.id === landing.id)!.name).toBe("LANDING");
  });

  it("cannot rename another tenant's collection", async () => {
    const theirs = seedCollection(B, "landing");
    const snapshot = indexBytes(B);
    await expectError(renameCollection(depsA(), theirs.id, "mine now"), 404, "collection_not_found");
    expect(indexBytes(B)).toBe(snapshot);
    expect(fake.state.uploads).toEqual([]);
  });

  it("deleting a collection keeps its files and other collections' memberships", async () => {
    const f1 = seedFile(A);
    const f2 = seedFile(A);
    const landing = seedCollection(A, "landing");
    const blog = seedCollection(A, "blog");
    seedItem(A, landing.id, f1.id);
    seedItem(A, landing.id, f2.id);
    seedItem(A, blog.id, f1.id);

    await deleteCollection(depsA(), landing.id);
    expect(filesOf(A).map((r) => r.id)).toEqual([f1.id, f2.id]);
    expect(fake.state.removes).toEqual([]);
    expect(fileObjects()).toHaveLength(2);
    expect(itemsOf(A)).toEqual([{ collection_id: blog.id, file_id: f1.id }]);
  });

  it("cannot delete another tenant's collection", async () => {
    const theirs = seedCollection(B, "landing");
    const f = seedFile(B);
    seedItem(B, theirs.id, f.id);
    const snapshot = indexBytes(B);
    await expectError(deleteCollection(depsA(), theirs.id), 404, "collection_not_found");
    expect(indexBytes(B)).toBe(snapshot);
  });
});

describe("collection membership", () => {
  it("is idempotent across repeats, duplicate ids and upper-case ids", async () => {
    const col = seedCollection(A, "landing");
    const f1 = seedFile(A);
    const f2 = seedFile(A);
    await addFilesToCollection(depsA(), col.id, [f1.id, f2.id]);
    const writes = fake.state.uploads.length;
    await addFilesToCollection(depsA(), col.id.toUpperCase(), [f1.id, f1.id, f2.id.toUpperCase()]);
    expect(fake.state.uploads.length).toBe(writes);
    expect(itemsOf(A)).toHaveLength(2);
    const out = await listWorkspaceFiles(depsA());
    expect(out.collections[0].file_count).toBe(2);
  });

  it("adds nothing when any file belongs to another tenant", async () => {
    const col = seedCollection(A, "landing");
    const mine = seedFile(A);
    const theirs = seedFile(B);
    await expectError(addFilesToCollection(depsA(), col.id, [mine.id, theirs.id]), 404, "file_not_found");
    expect(itemsOf(A)).toEqual([]);
    expect(fake.state.uploads).toEqual([]);
  });

  it("cannot add the tenant's own file to another tenant's collection", async () => {
    const theirs = seedCollection(B, "landing");
    const mine = seedFile(A);
    await expectError(addFilesToCollection(depsA(), theirs.id, [mine.id]), 404, "collection_not_found");
    expect(itemsOf(B)).toEqual([]);
  });

  it.each([[[]], ["not-an-array"], [["nope"]], [Array.from({ length: 101 }, () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")]])(
    "rejects file_ids %#",
    async (ids) => {
      const col = seedCollection(A, "landing");
      await expectError(addFilesToCollection(depsA(), col.id, ids), 400, "bad_file_ids");
    },
  );

  it("removes one membership and leaves the file", async () => {
    const col = seedCollection(A, "landing");
    const f = seedFile(A);
    seedItem(A, col.id, f.id);
    await removeFileFromCollection(depsA(), col.id, f.id);
    expect(itemsOf(A)).toEqual([]);
    expect(filesOf(A)).toHaveLength(1);
  });

  it("cannot remove a membership from another tenant's collection", async () => {
    const col = seedCollection(B, "landing");
    const f = seedFile(B);
    seedItem(B, col.id, f.id);
    await expectError(removeFileFromCollection(depsA(), col.id, f.id), 404, "collection_not_found");
    expect(itemsOf(B)).toHaveLength(1);
  });
});

describe("readPublicWorkspaceFile", () => {
  const storage = () => fake.client().storage as unknown as WorkspaceFilesDeps["storage"];

  it("serves the exact bytes of an uploaded photo with its sniffed type", async () => {
    const [row] = await uploadWorkspaceFiles(depsA(), { files: [file("Hero.jpg", BYTES.jpeg, "image/jpeg")] });
    const out = await readPublicWorkspaceFile(storage(), A, row.id, "Hero.jpg");
    expect(out?.mime).toBe("image/jpeg");
    expect(out?.body.equals(BYTES.jpeg)).toBe(true);
  });

  it("never serves the index, even when asked for it by a crafted path", async () => {
    seedFile(A);
    expect(fake.state.objects.has(indexKey(A))).toBe(true);
    for (const [t, f, n] of [
      [A, "index.json", "x"],
      [A, "..", "index.json"],
      [A, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "../index.json"],
      [A, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", ".."],
      [`${A}/workspace-files`, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "index.json"],
    ]) {
      expect(await readPublicWorkspaceFile(storage(), t, f, n)).toBeNull();
    }
    expect(fake.state.downloads.some((d) => d.endsWith("index.json"))).toBe(false);
  });

  it("refuses an object under the prefix that is not an image", async () => {
    const id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    fake.state.objects.set(`${BUCKET}/${A}/workspace-files/${id}/page.png`, { body: BYTES.svg, contentType: "image/png" });
    expect(await readPublicWorkspaceFile(storage(), A, id, "page.png")).toBeNull();
  });

  it("answers null for a missing photo and 503 for a storage failure", async () => {
    expect(await readPublicWorkspaceFile(storage(), A, "ffffffff-ffff-4fff-8fff-ffffffffffff", "x.png")).toBeNull();
    fake.state.failDownload = { message: "timeout", statusCode: "544" };
    const errors = quiet();
    await expectError(readPublicWorkspaceFile(storage(), A, "ffffffff-ffff-4fff-8fff-ffffffffffff", "x.png"), 503, "files_unavailable");
    errors.mockRestore();
  });

  it("does not let tenant A's url shape reach tenant B's photo", async () => {
    const [row] = await uploadWorkspaceFiles(depsB(), { files: [file("b.png", BYTES.png, "image/png")] });
    expect(await readPublicWorkspaceFile(storage(), A, row.id, "b.png")).toBeNull();
    expect(await readPublicWorkspaceFile(storage(), B, row.id, "b.png")).not.toBeNull();
  });
});

describe("index shape on disk", () => {
  it("is versioned so a future reader can tell it apart", async () => {
    await createCollection(depsA(), "landing");
    expect(readIndexOf(A).version).toBe(1);
  });
});

describe("a storage read that lags behind the last write", () => {
  beforeEach(() => {
    fake.state.staleIndexReads = true;
  });

  it("finds a collection created a moment ago", async () => {
    const created = await createCollection(depsA(), "landing");
    await renameCollection(depsA(), created.id, "hero");
    await deleteCollection(depsA(), created.id);
    expect(readIndexOf(A).collections).toEqual([]);
  });

  it("keeps every collection when several are created back to back", async () => {
    await createCollection(depsA(), "one");
    await createCollection(depsA(), "two");
    await createCollection(depsA(), "three");
    expect(readIndexOf(A).collections.map((c) => c.name)).toEqual(["one", "two", "three"]);
    const listed = await listWorkspaceFiles(depsA());
    expect(listed.collections.map((c) => c.name)).toEqual(["one", "three", "two"]);
  });

  it("adds a just-uploaded photo to a just-created collection", async () => {
    const [photo] = await uploadWorkspaceFiles(depsA(), { files: [file("hero.png", BYTES.png, "image/png")] });
    const collection = await createCollection(depsA(), "landing");
    await addFilesToCollection(depsA(), collection.id, [photo!.id]);
    const listed = await listWorkspaceFiles(depsA());
    expect(listed.files.map((f) => f.collection_ids)).toEqual([[collection.id]]);
    expect(readIndexOf(A).collections[0]!.file_ids).toEqual([photo!.id]);
  });

  it("keeps an upload and a delete between later writes, however many came before", async () => {
    await createCollection(depsA(), "one");
    await createCollection(depsA(), "two");
    const [hero, team] = await uploadWorkspaceFiles(depsA(), {
      files: [file("hero.png", BYTES.png, "image/png"), file("team.png", BYTES.png, "image/png")],
    });
    await createCollection(depsA(), "three");
    await deleteWorkspaceFile(depsA(), team!.id);
    await createCollection(depsA(), "four");
    const listed = await listWorkspaceFiles(depsA());
    expect(listed.files.map((f) => f.id)).toEqual([hero!.id]);
    expect(listed.collections.map((c) => c.name).sort()).toEqual(["four", "one", "three", "two"]);
  });

  it("never lets one tenant's recent write stand in for another's", async () => {
    await createCollection(depsA(), "a-only");
    const listed = await listWorkspaceFiles(depsB());
    expect(listed.collections).toEqual([]);
  });

  it("still trusts storage once it has a newer write than this process made", async () => {
    await createCollection(depsA(), "mine");
    fake.state.staleIndexReads = false;
    const onDisk = readIndexOf(A) as ReturnType<typeof readIndexOf> & { rev: number };
    fake.state.objects.set(indexKey(A), {
      body: Buffer.from(JSON.stringify({ ...onDisk, rev: onDisk.rev + 5, collections: [] })),
      contentType: "application/json",
    });
    expect((await listWorkspaceFiles(depsA())).collections).toEqual([]);
  });
});
