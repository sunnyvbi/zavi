import { describe, it, expect, vi } from "vitest";
import { seedTemplate } from "@/services/provisioning/seed-template";
import { seedProvisionedRepo } from "@/services/provisioning/seed-provisioned-repo";

type Call = { url: string; method: string; body?: unknown };

function res(status: number, body: unknown = {}) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

const FILES: Record<string, string> = {
  "package.json": '{"name":"x"}\n',
  "app/page.tsx": "export default () => <h1>Café — 日本語 🚀</h1>;\n",
  "README.md": "# Seeded\n",
  ".env.example": "DATABASE_URL=\n",
};

function githubFake(opts: { treeStatus?: number; baseEntries?: Array<{ path: string }>; newTreeSha?: string } = {}) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (method === "GET" && url.endsWith("/git/commits/commit_base")) return res(200, { tree: { sha: "tree_base" } });
    if (method === "GET" && url.includes("/git/ref/heads/")) return res(200, { object: { sha: "commit_base" } });
    if (method === "GET" && url.includes("/git/trees/")) {
      return res(200, { tree: (opts.baseEntries ?? [{ path: "README.md" }]).map((e) => ({ type: "blob", ...e })) });
    }
    if (method === "GET") return res(200, { default_branch: "trunk" });
    if (method === "POST" && url.endsWith("/git/blobs")) return res(201, { sha: `real_blob_${calls.length}` });
    if (method === "POST" && url.endsWith("/git/trees")) {
      const status = opts.treeStatus ?? 201;
      return status === 201 ? res(201, { sha: opts.newTreeSha ?? "tree_new" }) : res(status, { message: "tree rejected" });
    }
    if (method === "POST" && url.endsWith("/git/commits")) return res(201, { sha: "commit_new" });
    if (method === "PATCH") return res(200, { object: { sha: "commit_new" } });
    return res(500, { message: `unexpected ${method} ${url}` });
  });
  return { fetchFn, calls };
}

const base = { token: () => "tok", files: FILES, commitMessage: "chore: seed starter app (nextjs-supabase-tailwind, generic)" };

describe("seedTemplate seeds with one inline-content tree call (no per-file blob uploads for text files)", () => {
  it("never POSTs /git/blobs and sends every file's exact content inline in ONE tree call", async () => {
    const { fetchFn, calls } = githubFake();
    const r = await seedTemplate("t1", "praxis-built/acme", { ...base, fetchFn: fetchFn as never });

    expect(r).toEqual({ seeded: true, commit_sha: "commit_new", branch: "trunk", file_count: 4 });
    expect(calls.filter((c) => c.url.endsWith("/git/blobs"))).toHaveLength(0);
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.url.replace("https://api.github.com/repos/praxis-built/acme", "")}`)).toEqual([
      "POST /git/trees",
      "POST /git/commits",
      "PATCH /git/refs/heads/trunk",
    ]);
    expect(calls).toHaveLength(7);

    const tree = writes[0].body as { base_tree: string; tree: Array<Record<string, unknown>> };
    expect(tree.base_tree).toBe("tree_base");
    expect(tree.tree).toHaveLength(4);
    for (const entry of tree.tree) {
      expect(entry).not.toHaveProperty("sha");
      expect(entry.mode).toBe("100644");
      expect(entry.type).toBe("blob");
      expect(entry.content).toBe(FILES[entry.path as string]);
    }
    expect(writes[1].body).toEqual({
      message: "chore: seed starter app (nextjs-supabase-tailwind, generic)",
      tree: "tree_new",
      parents: ["commit_base"],
    });
    expect(writes[2].body).toEqual({ sha: "commit_new", force: false });
  });

  it("a rejected tree call is captured as an error result by seedProvisionedRepo and no commit or ref update follows", async () => {
    const { fetchFn, calls } = githubFake({ treeStatus: 422 });
    const r = await seedProvisionedRepo("t1", "praxis-built/acme", {
      enabled: () => true,
      token: () => "tok",
      files: FILES,
      category: "generic",
      fetchFn: fetchFn as never,
    });

    expect(r).toMatchObject({ seeded: false, reason: "error", category: "generic" });
    expect((r as { error: string }).error).toContain("seedTemplate tree failed (422)");
    expect(calls.some((c) => c.url.endsWith("/git/commits") && c.method === "POST")).toBe(false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(calls.filter((c) => c.url.endsWith("/git/blobs"))).toHaveLength(0);
  });

  it("keeps the seed-once guard: a repo that already has package.json gets zero writes", async () => {
    const { fetchFn, calls } = githubFake({ baseEntries: [{ path: "package.json" }] });
    const r = await seedTemplate("t1", "praxis-built/acme", { ...base, fetchFn: fetchFn as never });

    expect(r).toMatchObject({ seeded: false, reason: "repo_not_empty" });
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("keeps the idempotency guard: an unchanged tree skips commit and ref update", async () => {
    const { fetchFn, calls } = githubFake({ newTreeSha: "tree_base" });
    const r = await seedTemplate("t1", "praxis-built/acme", { ...base, fetchFn: fetchFn as never });

    expect(r).toMatchObject({ seeded: false, reason: "already_seeded" });
    expect(calls.filter((c) => c.method !== "GET").map((c) => c.method)).toEqual(["POST"]);
  });
});
