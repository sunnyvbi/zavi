import { describe, it, expect } from "vitest";
import { seedTemplate, SEED_BLOB_CONCURRENCY } from "@/services/provisioning/seed-template";

type Res = { status: number; json: () => Promise<unknown>; text: () => Promise<string> };
const res = (status: number, body: unknown = {}): Res => ({ status, json: async () => body, text: async () => JSON.stringify(body) });

type Pending = { path: string; resolve: (r: Res) => void };

function deferredBlobFetch(opts: { defaultBranch?: string } = {}) {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const pending: Pending[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let launchedAfterFailure = 0;
  let sawFailure = false;
  const fetchFn = async (url: string, init?: { method?: string; body?: string }): Promise<Res> => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body });
    if (method === "GET" && url.endsWith("/git/commits/commit_base")) return res(200, { tree: { sha: "tree_base" } });
    if (method === "GET" && url.includes("/git/ref/heads/")) return res(200, { object: { sha: "commit_base" } });
    if (method === "GET" && url.includes("/git/trees/")) return res(200, { tree: [{ path: "README.md", type: "blob" }] });
    if (method === "GET") return res(200, { default_branch: opts.defaultBranch ?? "main" });
    if (method === "POST" && url.endsWith("/git/blobs")) {
      if (sawFailure) launchedAfterFailure++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const content = Buffer.from(JSON.parse(init?.body ?? "{}").content, "base64").toString("utf-8");
      return new Promise<Res>((resolve) => {
        pending.push({
          path: content,
          resolve: (r) => {
            inFlight--;
            if (r.status >= 300) sawFailure = true;
            resolve(r);
          },
        });
      });
    }
    if (method === "POST" && url.endsWith("/git/trees")) return res(201, { sha: "tree_new" });
    if (method === "POST" && url.endsWith("/git/commits")) return res(201, { sha: "commit_new" });
    if (method === "PATCH") return res(200, {});
    throw new Error(`unexpected ${method} ${url}`);
  };
  return {
    fetchFn,
    calls,
    pending,
    stats: () => ({ inFlight, maxInFlight, launchedAfterFailure }),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function drain(f: ReturnType<typeof deferredBlobFetch>, answer: (p: Pending) => Res, pick: (pending: Pending[]) => number = (q) => q.length - 1) {
  for (let guard = 0; guard < 200; guard++) {
    await tick();
    const p = f.pending.length ? f.pending.splice(pick(f.pending), 1)[0] : undefined;
    if (!p) {
      await tick();
      if (f.pending.length === 0) return;
      continue;
    }
    p.resolve(answer(p));
  }
}

function binaryFiles(n: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    files[`text/${i}.txt`] = `inline ${i}`;
    files[`bin/${i}.dat`] = `bin-${i}\u0000`;
  }
  return files;
}

describe("seedTemplate setup latency", () => {
  it("skips the repo lookup when the caller already knows the default branch, and seeds that branch", async () => {
    const f = deferredBlobFetch({ defaultBranch: "main" });
    const r = await seedTemplate("t1", "praxis-built/shop", {
      token: () => "tok",
      fetchFn: f.fetchFn as never,
      files: { "package.json": "{}" },
      defaultBranch: "trunk",
    });
    expect(r).toMatchObject({ seeded: true, branch: "trunk", commit_sha: "commit_new" });
    expect(f.calls.some((c) => c.method === "GET" && c.url === "https://api.github.com/repos/praxis-built/shop")).toBe(false);
    expect(f.calls.find((c) => c.url.includes("/git/ref/heads/"))?.url).toBe("https://api.github.com/repos/praxis-built/shop/git/ref/heads/trunk");
    expect(f.calls.find((c) => c.method === "PATCH")?.url).toBe("https://api.github.com/repos/praxis-built/shop/git/refs/heads/trunk");
  });

  it("still reads the default branch from GitHub when the caller does not know it", async () => {
    const f = deferredBlobFetch({ defaultBranch: "master" });
    const r = await seedTemplate("t1", "praxis-built/shop", { token: () => "tok", fetchFn: f.fetchFn as never, files: { "package.json": "{}" } });
    expect(r).toMatchObject({ seeded: true, branch: "master" });
    expect(f.calls[0]).toMatchObject({ method: "GET", url: "https://api.github.com/repos/praxis-built/shop" });
  });

  it(`creates blobs ${SEED_BLOB_CONCURRENCY} at a time, never more, and keeps the tree in file order whatever order they finish in`, async () => {
    const f = deferredBlobFetch();
    const files = binaryFiles(12);
    const shaFor = (content: string) => `sha:${content.replace("\u0000", "")}`;
    const seeding = seedTemplate("t1", "praxis-built/shop", { token: () => "tok", fetchFn: f.fetchFn as never, files });
    await tick();
    await tick();
    expect(f.stats().inFlight).toBe(SEED_BLOB_CONCURRENCY);
    await drain(f, (p) => res(201, { sha: shaFor(p.path) }));
    const r = await seeding;
    expect(r).toMatchObject({ seeded: true });
    expect(f.stats().maxInFlight).toBe(SEED_BLOB_CONCURRENCY);
    expect(f.calls.filter((c) => c.url.endsWith("/git/blobs"))).toHaveLength(12);
    const treeBody = JSON.parse(f.calls.find((c) => c.method === "POST" && c.url.endsWith("/git/trees"))!.body!);
    expect(treeBody.tree.map((e: { path: string }) => e.path)).toEqual(Object.keys(files));
    for (const e of treeBody.tree as Array<{ path: string; sha?: string; content?: string }>) {
      if (e.path.startsWith("bin/")) {
        expect(e.sha).toBe(shaFor(files[e.path]));
        expect(e.content).toBeUndefined();
      } else {
        expect(e.content).toBe(files[e.path]);
      }
    }
  });

  it("a failed blob fails the seed with the FIRST failing file's error in tree order, writes no tree, and starts no new blob after a failure", async () => {
    const f = deferredBlobFetch();
    const files = binaryFiles(12);
    const seeding = seedTemplate("t1", "praxis-built/shop", { token: () => "tok", fetchFn: f.fetchFn as never, files });
    const outcome = seeding.then(
      () => null,
      (e: Error) => e,
    );
    await tick();
    await tick();
    expect(f.pending.map((p) => p.path)).toEqual(["bin-0\u0000", "bin-1\u0000", "bin-2\u0000", "bin-3\u0000", "bin-4\u0000"]);
    await drain(
      f,
      (p) => (p.path === "bin-1\u0000" || p.path === "bin-3\u0000" ? res(500, { message: `boom ${p.path.replace("\u0000", "")}` }) : res(201, { sha: "ok" })),
      (q) => Math.max(0, q.findIndex((p) => p.path === "bin-3\u0000")),
    );
    const err = await outcome;
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/^seedTemplate blob bin\/1\.dat failed \(500\)/);
    expect(f.calls.some((c) => c.method === "POST" && c.url.endsWith("/git/trees"))).toBe(false);
    expect(f.calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(f.stats().launchedAfterFailure).toBe(0);
    expect(f.calls.filter((c) => c.url.endsWith("/git/blobs"))).toHaveLength(SEED_BLOB_CONCURRENCY);
  });
});
