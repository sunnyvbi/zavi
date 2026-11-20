// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

type Reply = { status: number; body?: unknown };
type Call = { key: string; body: unknown; signal?: AbortSignal; retry?: boolean };
const net = vi.hoisted(() => ({
  pending: [] as Array<Call & { resolve: (r: Reply) => void; reject: (e: unknown) => void }>,
  calls: [] as Call[],
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (
    path: string,
    opts: { method?: string; body?: unknown; signal?: AbortSignal; retryOnNetworkError?: boolean } = {},
  ) => {
    const call = {
      key: `${opts.method ?? "GET"} ${path}`,
      body: opts.body,
      signal: opts.signal,
      retry: opts.retryOnNetworkError,
    };
    net.calls.push(call);
    return new Promise((resolve, reject) => {
      net.pending.push({
        ...call,
        reject,
        resolve: (r: Reply) =>
          resolve({
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            json: async () => {
              if (r.body === undefined) throw new SyntaxError("Unexpected end of JSON input");
              return r.body;
            },
          }),
      });
    });
  },
}));

type AuthListener = (event: string, session: { access_token: string } | null) => void;
const auth = vi.hoisted(() => ({ listeners: new Set<AuthListener>() }));

vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    auth: {
      onAuthStateChange: (listener: AuthListener) => {
        auth.listeners.add(listener);
        return { data: { subscription: { unsubscribe: () => auth.listeners.delete(listener) } } };
      },
    },
  }),
}));

function tokenFor(tenantId: string): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "HS256" })}.${encode({ app_metadata: { active_tenant_id: tenantId } })}.sig`;
}

function authEvent(event: string, tenantId: string | null) {
  act(() => {
    for (const listener of [...auth.listeners]) {
      listener(event, tenantId ? { access_token: tokenFor(tenantId) } : null);
    }
  });
}

import { announceTenantSwitch } from "./tenantSwitch";
import {
  MAX_UPLOAD_BYTES,
  notifyWorkspaceFilesChanged,
  screenUploads,
  useWorkspaceFiles,
  type CollectionRow,
  type FileRow,
} from "./useWorkspaceFiles";

const GET = "GET /api/workspace/files";

async function reply(key: string, r: Reply, which: "first" | "last" = "first") {
  const matches = net.pending.filter((p) => p.key === key);
  const target = which === "first" ? matches[0] : matches[matches.length - 1];
  if (!target) {
    throw new Error(`no pending ${key}; pending: ${net.pending.map((p) => p.key).join(", ") || "none"}`);
  }
  net.pending.splice(net.pending.indexOf(target), 1);
  await act(async () => {
    target.resolve(r);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const photo = (id: string, extra: Partial<FileRow> = {}): FileRow => ({
  id,
  name: `${id}.png`,
  mime: "image/png",
  size: 2048,
  url: `https://cdn.test/${id}.png`,
  created_at: "2026-09-20T10:00:00.000Z",
  collection_ids: [],
  ...extra,
});

const collection = (id: string, name: string, file_count: number): CollectionRow => ({
  id,
  name,
  created_at: "2026-09-19T10:00:00.000Z",
  file_count,
});

function upload(name: string, type: string, size = 1024): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

async function mounted(files: FileRow[] = [], collections: CollectionRow[] = []) {
  const hook = renderHook(() => useWorkspaceFiles());
  await reply(GET, { status: 200, body: { files, collections } });
  return hook;
}

afterEach(() => {
  cleanup();
  net.pending.length = 0;
  net.calls.length = 0;
  auth.listeners.clear();
  vi.restoreAllMocks();
});

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
};

const beforeUnloadBlocked = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

describe("chat image saved to Files", () => {
  it("refetches an already-open Files list so the chat image appears without a remount", async () => {
    const { result, unmount } = await mounted([photo("old")]);
    expect(net.calls.filter((c) => c.key === GET)).toHaveLength(1);

    act(() => notifyWorkspaceFilesChanged());
    expect(net.calls.filter((c) => c.key === GET)).toHaveLength(2);
    await reply(GET, { status: 200, body: { files: [photo("chat", { mime: "image/jpeg" }), photo("old")], collections: [] } });
    expect(result.current.files.map((f) => f.id)).toEqual(["chat", "old"]);

    unmount();
    act(() => notifyWorkspaceFilesChanged());
    expect(net.calls.filter((c) => c.key === GET)).toHaveLength(2);
  });
});

describe("screenUploads", () => {
  it("keeps only supported images up to 10 MB and says why the rest were skipped", () => {
    const out = screenUploads([
      upload("logo.svg", "image/svg+xml"),
      upload("huge.png", "image/png", 12 * 1024 * 1024),
      upload("edge.webp", "image/webp", MAX_UPLOAD_BYTES),
      upload("noext", ""),
      upload("typeless.JPG", ""),
    ]);
    expect(out.accepted.map((f) => f.name)).toEqual(["edge.webp", "typeless.JPG"]);
    expect(out.skipped).toEqual([
      { name: "logo.svg", reason: "Not a PNG, JPEG, WebP, GIF or AVIF image" },
      { name: "huge.png", reason: "Larger than 10 MB" },
      { name: "noext", reason: "Not a PNG, JPEG, WebP, GIF or AVIF image" },
    ]);
  });
});

describe("useWorkspaceFiles loading", () => {
  it("never lets an older GET that answers last overwrite a newer one", async () => {
    const { result } = renderHook(() => useWorkspaceFiles());
    const firstSignal = net.calls[0]!.signal!;
    act(() => {
      void result.current.load();
    });
    expect(firstSignal.aborted).toBe(true);

    await reply(GET, { status: 200, body: { files: [photo("fresh")], collections: [] } }, "last");
    await reply(GET, { status: 200, body: { files: [photo("stale")], collections: [collection("old", "old", 1)] } });

    expect(result.current.files.map((f) => f.id)).toEqual(["fresh"]);
    expect(result.current.collections).toEqual([]);
    expect(result.current.status).toBe("ready");
  });

  it("re-fetches instead of applying a list that was read before a delete landed", async () => {
    const { result } = await mounted([photo("a"), photo("b")]);
    act(() => {
      void result.current.load();
    });
    act(() => {
      void result.current.remove("a");
    });
    await reply("DELETE /api/workspace/files/a", { status: 204 });
    await reply(GET, { status: 200, body: { files: [photo("a"), photo("b")], collections: [] } });

    expect(result.current.files.map((f) => f.id)).toEqual(["b"]);
    expect(net.pending.map((p) => p.key)).toEqual([GET]);
    await reply(GET, { status: 200, body: { files: [photo("b")], collections: [] } });
    expect(result.current.files.map((f) => f.id)).toEqual(["b"]);
  });

  it("aborts the in-flight load when it unmounts", () => {
    const { unmount } = renderHook(() => useWorkspaceFiles());
    const signal = net.calls[0]!.signal!;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("shows the server's message when the list cannot load, and recovers on retry", async () => {
    const { result } = renderHook(() => useWorkspaceFiles());
    await reply(GET, { status: 500, body: { error: { code: "internal", message: "Storage is down" } } });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Storage is down");
    act(() => {
      void result.current.load();
    });
    expect(result.current.status).toBe("loading");
    await reply(GET, { status: 200, body: { files: [photo("a")], collections: [] } });
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeNull();
  });
});

describe("useWorkspaceFiles uploads", () => {
  it("never calls the API for an svg or a 12 MB file, and reports both", async () => {
    const { result } = await mounted();
    const before = net.calls.length;
    let outcome: Awaited<ReturnType<typeof result.current.upload>> | undefined;
    await act(async () => {
      outcome = await result.current.upload([
        upload("logo.svg", "image/svg+xml"),
        upload("huge.png", "image/png", 12 * 1024 * 1024),
      ]);
    });
    expect(net.calls.length).toBe(before);
    expect(outcome!.uploaded).toEqual([]);
    expect(outcome!.skipped.map((s) => s.name)).toEqual(["logo.svg", "huge.png"]);
    expect(result.current.pending).toEqual([]);
  });

  it("sends collection_id when uploading into a collection and counts the new photo there", async () => {
    const { result } = await mounted([], [collection("c1", "landing", 0)]);
    act(() => {
      void result.current.upload([upload("hero.png", "image/png"), upload("logo.svg", "image/svg+xml")], "c1");
    });
    const post = net.calls.find((c) => c.key === "POST /api/workspace/files")!;
    const form = post.body as FormData;
    expect(form.get("collection_id")).toBe("c1");
    expect((form.getAll("files") as File[]).map((f) => f.name)).toEqual(["hero.png"]);
    expect(result.current.pending.map((p) => [p.name, p.status, p.collectionId])).toEqual([
      ["hero.png", "uploading", "c1"],
    ]);

    await reply("POST /api/workspace/files", {
      status: 201,
      body: { files: [photo("hero", { collection_ids: ["c1"] })] },
    });
    expect(result.current.pending).toEqual([]);
    expect(result.current.files.map((f) => f.id)).toEqual(["hero"]);
    expect(result.current.collections[0]!.file_count).toBe(1);
  });

  it("splits more than 20 photos into requests sent one after another, never at once", async () => {
    const { result } = await mounted();
    await act(async () => {
      void result.current.upload(Array.from({ length: 23 }, (_, i) => upload(`p${i}.png`, "image/png")));
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    const posts = () => net.calls.filter((c) => c.key === "POST /api/workspace/files");
    expect(posts().map((c) => (c.body as FormData).getAll("files").length)).toEqual([20]);
    await reply("POST /api/workspace/files", { status: 201, body: { files: [] } });
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(posts().map((c) => (c.body as FormData).getAll("files").length)).toEqual([20, 3]);
  });

  it("queues a second upload behind the first instead of racing it", async () => {
    const { result } = await mounted();
    await act(async () => {
      void result.current.upload([upload("a.png", "image/png")]);
      void result.current.upload([upload("b.png", "image/png")]);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    const posts = () => net.calls.filter((c) => c.key === "POST /api/workspace/files");
    expect(posts()).toHaveLength(1);
    await reply("POST /api/workspace/files", { status: 500, body: { error: { code: "x", message: "boom" } } });
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(posts()).toHaveLength(2);
  });

  it("keeps a failed upload with the server's reason until it is dismissed", async () => {
    const { result } = await mounted();
    act(() => {
      void result.current.upload([upload("big.gif", "image/gif")]);
    });
    await reply("POST /api/workspace/files", {
      status: 413,
      body: { error: { code: "too_large", message: "big.gif is over the 10 MB limit." } },
    });
    expect(result.current.pending).toMatchObject([
      { name: "big.gif", status: "failed", error: "big.gif is over the 10 MB limit." },
    ]);
    expect(result.current.files).toEqual([]);
    act(() => result.current.dismissPending(result.current.pending[0]!.id));
    expect(result.current.pending).toEqual([]);
  });

  it("falls back to a size message when a 413 carries no body", async () => {
    const { result } = await mounted();
    act(() => {
      void result.current.upload([upload("big.png", "image/png")]);
    });
    await reply("POST /api/workspace/files", { status: 413 });
    expect(result.current.pending[0]!.error).toBe("That file is larger than 10 MB.");
  });

  it("does nothing after it unmounts mid-upload: no state, no follow-up requests", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, unmount } = await mounted();
    let done: Promise<unknown> | undefined;
    act(() => {
      done = result.current.upload([upload("hero.png", "image/png")]);
    });
    expect(result.current.pending).toHaveLength(1);
    unmount();
    const callsAtUnmount = net.calls.length;
    await reply("POST /api/workspace/files", { status: 201, body: { files: [photo("hero")] } });
    await expect(done).resolves.toMatchObject({ failed: 0 });
    expect(net.calls.length).toBe(callsAtUnmount);
    expect(result.current.files).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("useWorkspaceFiles optimistic edits", () => {
  it("removes a photo at once and puts it back in place, counts included, when the delete fails", async () => {
    const { result } = await mounted(
      [
        photo("newest", { created_at: "2026-09-22T00:00:00.000Z" }),
        photo("middle", { created_at: "2026-09-21T00:00:00.000Z", collection_ids: ["c1"] }),
        photo("oldest", { created_at: "2026-09-20T00:00:00.000Z" }),
      ],
      [collection("c1", "landing", 1)],
    );
    let outcome: Promise<{ ok: boolean }> | undefined;
    act(() => {
      outcome = result.current.remove("middle");
    });
    expect(result.current.files.map((f) => f.id)).toEqual(["newest", "oldest"]);
    expect(result.current.collections[0]!.file_count).toBe(0);

    await reply("DELETE /api/workspace/files/middle", {
      status: 500,
      body: { error: { code: "internal", message: "Storage is down" } },
    });
    expect(result.current.files.map((f) => f.id)).toEqual(["newest", "middle", "oldest"]);
    expect(result.current.collections[0]!.file_count).toBe(1);
    await expect(outcome).resolves.toEqual({ ok: false, code: "internal", message: "Storage is down" });
  });

  it("deletes a collection without touching its photos", async () => {
    const { result } = await mounted(
      [photo("a", { collection_ids: ["c1", "c2"] }), photo("b", { collection_ids: ["c1"] })],
      [collection("c1", "landing", 2), collection("c2", "hero", 1)],
    );
    act(() => {
      void result.current.deleteCollection("c1");
    });
    expect(result.current.collections.map((c) => c.id)).toEqual(["c2"]);
    expect(result.current.files.map((f) => [f.id, f.collection_ids])).toEqual([
      ["a", ["c2"]],
      ["b", []],
    ]);
    await reply("DELETE /api/workspace/file-collections/c1", { status: 204 });
    expect(result.current.files.map((f) => f.id)).toEqual(["a", "b"]);
    expect(net.calls.some((c) => c.key.startsWith("DELETE /api/workspace/files/"))).toBe(false);
  });

  it("restores a collection and its memberships when deleting it fails", async () => {
    const { result } = await mounted(
      [photo("a", { collection_ids: ["c1"] })],
      [collection("c0", "first", 0), collection("c1", "landing", 1), collection("c2", "last", 0)],
    );
    act(() => {
      void result.current.deleteCollection("c1");
    });
    await reply("DELETE /api/workspace/file-collections/c1", { status: 500 });
    expect(result.current.collections.map((c) => c.id)).toEqual(["c0", "c1", "c2"]);
    expect(result.current.files[0]!.collection_ids).toEqual(["c1"]);
  });

  it("adds only photos not already in the collection, and undoes the add on failure", async () => {
    const { result } = await mounted(
      [photo("a", { collection_ids: ["c1"] }), photo("b"), photo("c")],
      [collection("c1", "landing", 1)],
    );
    act(() => {
      void result.current.addToCollection("c1", ["a", "b", "c"]);
    });
    const post = net.calls.find((c) => c.key === "POST /api/workspace/file-collections/c1/files")!;
    expect(JSON.parse(post.body as string)).toEqual({ file_ids: ["b", "c"] });
    expect(result.current.collections[0]!.file_count).toBe(3);

    await reply("POST /api/workspace/file-collections/c1/files", { status: 500 });
    expect(result.current.collections[0]!.file_count).toBe(1);
    expect(result.current.files.map((f) => f.collection_ids)).toEqual([["c1"], [], []]);
  });

  it("takes a photo out of one collection and restores it on failure", async () => {
    const { result } = await mounted([photo("a", { collection_ids: ["c1"] })], [collection("c1", "landing", 1)]);
    act(() => {
      void result.current.removeFromCollection("c1", "a");
    });
    expect(result.current.files[0]!.collection_ids).toEqual([]);
    expect(result.current.collections[0]!.file_count).toBe(0);
    await reply("DELETE /api/workspace/file-collections/c1/files/a", { status: 500 });
    expect(result.current.files[0]!.collection_ids).toEqual(["c1"]);
    expect(result.current.collections[0]!.file_count).toBe(1);
  });
});

describe("useWorkspaceFiles collections", () => {
  it("returns the 409 message and adds nothing when the name is taken", async () => {
    const { result } = await mounted([], [collection("c1", "landing", 0)]);
    let outcome: Promise<unknown> | undefined;
    act(() => {
      outcome = result.current.createCollection("  landing ");
    });
    const post = net.calls.find((c) => c.key === "POST /api/workspace/file-collections")!;
    expect(JSON.parse(post.body as string)).toEqual({ name: "landing" });
    await reply("POST /api/workspace/file-collections", {
      status: 409,
      body: { error: { code: "collection_exists", message: "You already have a collection called landing." } },
    });
    await expect(outcome).resolves.toEqual({
      ok: false,
      code: "collection_exists",
      message: "You already have a collection called landing.",
    });
    expect(result.current.collections.map((c) => c.id)).toEqual(["c1"]);
  });

  it("refuses an empty or 61-character name without calling the API", async () => {
    const { result } = await mounted();
    const before = net.calls.length;
    const empty = await result.current.createCollection("   ");
    const long = await result.current.createCollection("x".repeat(61));
    const rename = await result.current.renameCollection("c1", "");
    expect([empty.ok, long.ok, rename.ok]).toEqual([false, false, false]);
    expect(net.calls.length).toBe(before);
  });

  it("adds a created collection and applies a rename while keeping its count", async () => {
    const { result } = await mounted([], [collection("c1", "landing", 4)]);
    act(() => {
      void result.current.createCollection("hero");
    });
    await reply("POST /api/workspace/file-collections", {
      status: 201,
      body: { collection: collection("c2", "hero", 0) },
    });
    act(() => {
      void result.current.renameCollection("c1", "home");
    });
    await reply("PATCH /api/workspace/file-collections/c1", {
      status: 200,
      body: { collection: { id: "c1", name: "home", created_at: "2026-09-19T10:00:00.000Z" } },
    });
    expect(result.current.collections.map((c) => [c.name, c.file_count])).toEqual([
      ["home", 4],
      ["hero", 0],
    ]);
  });
});

const SWITCH_STOPPED = "Stopped because a workspace switch started. Upload it again to keep it.";

describe("useWorkspaceFiles workspace switch", () => {
  it("stops before the next batch the moment a switch starts, and stays stopped if the switch fails", async () => {
    const { result } = await mounted();
    authEvent("INITIAL_SESSION", "tenant-a");
    const posts = () => net.calls.filter((c) => c.key === "POST /api/workspace/files");
    let outcome: Promise<{ uploaded: FileRow[]; failed: number }> | undefined;
    act(() => {
      outcome = result.current.upload(Array.from({ length: 45 }, (_, i) => upload(`p${i}.png`, "image/png")));
    });
    await flush();
    expect(posts()).toHaveLength(1);

    act(() => {
      announceTenantSwitch();
    });
    await reply("POST /api/workspace/files", { status: 201, body: { files: [photo("p0")] } });
    await flush();
    expect(posts()).toHaveLength(1);
    await expect(outcome).resolves.toMatchObject({ failed: 25 });

    authEvent("TOKEN_REFRESHED", "tenant-a");
    await flush();
    expect(posts()).toHaveLength(1);
    const failed = result.current.pending.filter((p) => p.status === "failed");
    expect(failed).toHaveLength(25);
    expect(new Set(failed.map((p) => p.error))).toEqual(new Set([SWITCH_STOPPED]));
    expect(result.current.pending.some((p) => p.status === "uploading")).toBe(false);

    act(() => {
      void result.current.upload([upload("again.png", "image/png")]);
    });
    await flush();
    expect(posts()).toHaveLength(2);
  });

  it("never sends another batch once the session moves to a different tenant, and fails the rest", async () => {
    const { result } = await mounted();
    authEvent("INITIAL_SESSION", "tenant-a");
    const posts = () => net.calls.filter((c) => c.key === "POST /api/workspace/files");
    let first: Promise<{ uploaded: FileRow[]; failed: number }> | undefined;
    let queued: Promise<{ uploaded: FileRow[]; failed: number }> | undefined;
    act(() => {
      first = result.current.upload(Array.from({ length: 45 }, (_, i) => upload(`p${i}.png`, "image/png")));
      queued = result.current.upload([upload("later.png", "image/png")]);
    });
    await flush();
    expect(posts()).toHaveLength(1);
    expect(beforeUnloadBlocked()).toBe(true);

    authEvent("TOKEN_REFRESHED", "tenant-a");
    authEvent("TOKEN_REFRESHED", "tenant-b");
    await reply("POST /api/workspace/files", { status: 201, body: { files: [photo("p0")] } });
    await flush();

    expect(posts()).toHaveLength(1);
    expect(net.pending.filter((p) => p.key.startsWith("POST"))).toEqual([]);
    await expect(first).resolves.toMatchObject({ failed: 25 });
    await expect(queued).resolves.toMatchObject({ uploaded: [], failed: 1 });
    const failed = result.current.pending.filter((p) => p.status === "failed");
    expect(failed).toHaveLength(26);
    expect(new Set(failed.map((p) => p.error))).toEqual(new Set([SWITCH_STOPPED]));
    expect(result.current.pending.some((p) => p.status === "uploading")).toBe(false);
    expect(beforeUnloadBlocked()).toBe(false);
  });

  it("keeps uploading when a token refresh keeps the same tenant", async () => {
    const { result } = await mounted();
    authEvent("INITIAL_SESSION", "tenant-a");
    act(() => {
      void result.current.upload(Array.from({ length: 25 }, (_, i) => upload(`p${i}.png`, "image/png")));
    });
    await flush();
    authEvent("TOKEN_REFRESHED", "tenant-a");
    await reply("POST /api/workspace/files", { status: 201, body: { files: [] } });
    await flush();
    expect(net.calls.filter((c) => c.key === "POST /api/workspace/files")).toHaveLength(2);
  });

  it("warns before the page unloads only while an upload is running", async () => {
    const { result } = await mounted();
    expect(beforeUnloadBlocked()).toBe(false);
    act(() => {
      void result.current.upload([upload("a.png", "image/png")]);
    });
    expect(beforeUnloadBlocked()).toBe(true);
    await reply("POST /api/workspace/files", { status: 201, body: { files: [photo("a")] } });
    await flush();
    expect(beforeUnloadBlocked()).toBe(false);
  });
});

describe("useWorkspaceFiles already-gone targets", () => {
  it("treats a 404 file_not_found delete as done and never resurrects the photo", async () => {
    const { result } = await mounted([photo("a", { collection_ids: ["c1"] }), photo("b")], [collection("c1", "landing", 1)]);
    let outcome: Promise<unknown> | undefined;
    act(() => {
      outcome = result.current.remove("a");
    });
    await reply("DELETE /api/workspace/files/a", {
      status: 404,
      body: { error: { code: "file_not_found", message: "That file was not found." } },
    });
    await expect(outcome).resolves.toEqual({ ok: true, value: null });
    expect(result.current.files.map((f) => f.id)).toEqual(["b"]);
    expect(result.current.collections[0]!.file_count).toBe(0);
  });

  it("treats a 404 collection_not_found collection delete as done", async () => {
    const { result } = await mounted([photo("a", { collection_ids: ["c1"] })], [collection("c1", "landing", 1)]);
    let outcome: Promise<unknown> | undefined;
    act(() => {
      outcome = result.current.deleteCollection("c1");
    });
    await reply("DELETE /api/workspace/file-collections/c1", {
      status: 404,
      body: { error: { code: "collection_not_found", message: "That collection was not found." } },
    });
    await expect(outcome).resolves.toEqual({ ok: true, value: null });
    expect(result.current.collections).toEqual([]);
    expect(result.current.files[0]!.collection_ids).toEqual([]);
  });

  it("treats a 404 on removing a membership as done, for either the file or the collection", async () => {
    const { result } = await mounted(
      [photo("a", { collection_ids: ["c1"] }), photo("b", { collection_ids: ["c1"] })],
      [collection("c1", "landing", 2)],
    );
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    act(() => {
      first = result.current.removeFromCollection("c1", "a");
      second = result.current.removeFromCollection("c1", "b");
    });
    await reply("DELETE /api/workspace/file-collections/c1/files/a", {
      status: 404,
      body: { error: { code: "file_not_found", message: "That file was not found." } },
    });
    await reply("DELETE /api/workspace/file-collections/c1/files/b", {
      status: 404,
      body: { error: { code: "collection_not_found", message: "That collection was not found." } },
    });
    await expect(first).resolves.toEqual({ ok: true, value: null });
    await expect(second).resolves.toEqual({ ok: true, value: null });
    expect(result.current.files.map((f) => f.collection_ids)).toEqual([[], []]);
    expect(result.current.collections[0]!.file_count).toBe(0);
  });

  it("still rolls back a 404 whose code is not a gone-target code", async () => {
    const { result } = await mounted([photo("a")]);
    act(() => {
      void result.current.remove("a");
    });
    await reply("DELETE /api/workspace/files/a", { status: 404, body: { error: { code: "route_missing", message: "Nope" } } });
    expect(result.current.files.map((f) => f.id)).toEqual(["a"]);
  });
});

describe("useWorkspaceFiles refresh during a mutation", () => {
  it("does not bring back a photo whose delete is still in flight when a refresh answers first", async () => {
    const { result } = await mounted([photo("a"), photo("b")]);
    act(() => {
      void result.current.remove("a");
    });
    act(() => {
      void result.current.load();
    });
    await reply(GET, { status: 200, body: { files: [photo("a"), photo("b")], collections: [] } });
    expect(result.current.files.map((f) => f.id)).toEqual(["b"]);

    await reply("DELETE /api/workspace/files/a", { status: 204 });
    expect(result.current.files.map((f) => f.id)).toEqual(["b"]);
    expect(net.pending.map((p) => p.key)).toEqual([GET]);
    await reply(GET, { status: 200, body: { files: [photo("b"), photo("c")], collections: [] } });
    expect(result.current.files.map((f) => f.id)).toEqual(["b", "c"]);
  });

  it("does not drop a membership whose add is still in flight when a refresh answers first", async () => {
    const { result } = await mounted([photo("a")], [collection("c1", "landing", 0)]);
    act(() => {
      void result.current.addToCollection("c1", ["a"]);
    });
    act(() => {
      void result.current.load();
    });
    await reply(GET, { status: 200, body: { files: [photo("a")], collections: [collection("c1", "landing", 0)] } });
    expect(result.current.files[0]!.collection_ids).toEqual(["c1"]);
    expect(result.current.collections[0]!.file_count).toBe(1);
  });
});

describe("useWorkspaceFiles collection writes", () => {
  it("never retries creating a collection or adding to one on a network blip", async () => {
    const { result } = await mounted([photo("a")], [collection("c1", "landing", 0)]);
    act(() => {
      void result.current.createCollection("hero");
      void result.current.addToCollection("c1", ["a"]);
    });
    expect(net.calls.find((c) => c.key === "POST /api/workspace/file-collections")!.retry).toBe(false);
    expect(net.calls.find((c) => c.key === "POST /api/workspace/file-collections/c1/files")!.retry).toBe(false);
  });
});
