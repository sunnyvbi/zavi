import { describe, it, expect, vi } from "vitest";
import { seedTemplate } from "@/services/provisioning/seed-template";
import { CredentialNotConfigured } from "@/services/provisioning/github-repo";
import {
  seedProvisionedRepo,
  isSeedTemplateEnabled,
} from "@/services/provisioning/seed-provisioned-repo";

function res(status: number, body: unknown = {}) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

const FILES = { "package.json": '{"name":"x"}\n', "app/page.tsx": "export default () => null;\n" };

function happyPathFetch(
  opts: {
    defaultBranch?: string;
    newTreeSha?: string;
    baseTreeEntries?: Array<{ path: string; type?: string }>;
  } = {},
) {
  const branch = opts.defaultBranch ?? "main";
  const newTreeSha = opts.newTreeSha ?? "tree_new";
  const baseTreeEntries = opts.baseTreeEntries ?? [{ path: "README.md" }];
  let blob = 0;
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/git/commits/commit_base")) {
      return res(200, { tree: { sha: "tree_base" } });
    }
    if (method === "GET" && url.includes("/git/ref/heads/")) {
      return res(200, { object: { sha: "commit_base" } });
    }
    if (method === "GET" && url.includes("/git/trees/")) {
      return res(200, {
        tree: baseTreeEntries.map((e) => ({ type: "blob", ...e })),
      });
    }
    if (method === "GET") {
      return res(200, { default_branch: branch });
    }
    if (method === "POST" && url.endsWith("/git/blobs")) {
      return res(201, { sha: `blob_${blob++}` });
    }
    if (method === "POST" && url.endsWith("/git/trees")) {
      return res(201, { sha: newTreeSha });
    }
    if (method === "POST" && url.endsWith("/git/commits")) {
      return res(201, { sha: "commit_new" });
    }
    if (method === "PATCH" && url.includes("/git/refs/heads/")) {
      return res(200, { object: { sha: "commit_new" } });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
}

describe("seedTemplate", () => {
  it("THROWS CredentialNotConfigured when the umbrella token is missing (gated)", async () => {
    await expect(
      seedTemplate("t1", "praxis-built/acme", { token: () => null, fetchFn: vi.fn() as never, files: FILES }),
    ).rejects.toBeInstanceOf(CredentialNotConfigured);
    await expect(
      seedTemplate("t1", "praxis-built/acme", { token: () => null, fetchFn: vi.fn() as never, files: FILES }),
    ).rejects.toMatchObject({ key: "GITHUB_PROVISION_TOKEN" });
  });

  it("rejects a malformed repo_full_name", async () => {
    await expect(
      seedTemplate("t1", "no-slash", { token: () => "tok", fetchFn: vi.fn() as never, files: FILES }),
    ).rejects.toThrow(/invalid repo_full_name/i);
  });

  it("rejects an empty template set", async () => {
    await expect(
      seedTemplate("t1", "praxis-built/acme", { token: () => "tok", fetchFn: vi.fn() as never, files: {} }),
    ).rejects.toThrow(/no template files/i);
  });

  it("seeds the tree onto main in a single commit (inline tree→commit→ref PATCH)", async () => {
    const fetchFn = happyPathFetch();
    const r = await seedTemplate("t1", "praxis-built/acme", {
      token: () => "tok",
      fetchFn: fetchFn as never,
      files: FILES,
    });
    expect(r).toEqual({ seeded: true, commit_sha: "commit_new", branch: "main", file_count: 2 });

    const calls = fetchFn.mock.calls.map((c) => `${c[1]?.method ?? "GET"} ${c[0]}`);
    expect(calls.filter((c) => c.includes("/git/blobs"))).toHaveLength(0);
    expect(calls.filter((c) => c.endsWith("/git/trees"))).toHaveLength(1);
    expect(calls.filter((c) => c.endsWith("/git/commits"))).toHaveLength(1);
    const refCall = fetchFn.mock.calls.find((c) => String(c[0]).includes("/git/refs/heads/"));
    expect(refCall?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(refCall?.[1]?.body))).toMatchObject({ sha: "commit_new", force: false });
  });

  it("tree is layered on the base tree (preserves auto_init README)", async () => {
    const fetchFn = happyPathFetch();
    await seedTemplate("t1", "praxis-built/acme", { token: () => "tok", fetchFn: fetchFn as never, files: FILES });
    const treeCall = fetchFn.mock.calls.find((c) => String(c[0]).endsWith("/git/trees"));
    const body = JSON.parse(String(treeCall?.[1]?.body));
    expect(body.base_tree).toBe("tree_base");
    expect(body.tree).toHaveLength(2);
    expect(body.tree[0]).toMatchObject({ mode: "100644", type: "blob" });
  });

  it("a binary file still goes up as a base64 blob, and only that file", async () => {
    const fetchFn = happyPathFetch();
    const binary = "PK\u0000\u0003raw";
    await seedTemplate("t1", "praxis-built/acme", {
      token: () => "tok",
      fetchFn: fetchFn as never,
      files: { ...FILES, "public/asset.bin": binary },
    });
    const blobCalls = fetchFn.mock.calls.filter((c) => String(c[0]).endsWith("/git/blobs"));
    expect(blobCalls).toHaveLength(1);
    const body = JSON.parse(String(blobCalls[0][1]?.body));
    expect(body.encoding).toBe("base64");
    expect(Buffer.from(body.content, "base64").toString("utf-8")).toBe(binary);
    const treeCall = fetchFn.mock.calls.find((c) => String(c[0]).endsWith("/git/trees"));
    const tree = JSON.parse(String(treeCall?.[1]?.body)).tree as Array<Record<string, unknown>>;
    expect(tree.find((e) => e.path === "public/asset.bin")).toEqual({
      path: "public/asset.bin",
      mode: "100644",
      type: "blob",
      sha: "blob_0",
    });
    expect(tree.find((e) => e.path === "package.json")).toEqual({
      path: "package.json",
      mode: "100644",
      type: "blob",
      content: FILES["package.json"],
    });
  });

  it("IDEMPOTENT: when the new tree equals the base tree, skips commit + ref update", async () => {
    const fetchFn = happyPathFetch({ newTreeSha: "tree_base" });
    const r = await seedTemplate("t1", "praxis-built/acme", {
      token: () => "tok",
      fetchFn: fetchFn as never,
      files: FILES,
    });
    expect(r).toEqual({ seeded: false, reason: "already_seeded", branch: "main", file_count: 2 });
    const calls = fetchFn.mock.calls.map((c) => `${c[1]?.method ?? "GET"} ${c[0]}`);
    expect(calls.some((c) => c.endsWith("/git/commits") && c.startsWith("POST"))).toBe(false);
    expect(calls.some((c) => c.includes("/git/refs/heads/"))).toBe(false);
  });

  it("REFUSES to re-seed once the repo already has an app (never clobber built code)", async () => {
    const fetchFn = happyPathFetch({
      baseTreeEntries: [{ path: "README.md" }, { path: "package.json" }, { path: "app" }],
    });
    const r = await seedTemplate("t1", "praxis-built/acme", {
      token: () => "tok",
      fetchFn: fetchFn as never,
      files: FILES,
    });
    expect(r).toEqual({ seeded: false, reason: "repo_not_empty", branch: "main", file_count: 2 });

    const calls = fetchFn.mock.calls.map((c) => `${c[1]?.method ?? "GET"} ${c[0]}`);
    expect(calls.some((c) => c.includes("/git/blobs"))).toBe(false);
    expect(calls.some((c) => c.endsWith("/git/trees") && c.startsWith("POST"))).toBe(false);
    expect(calls.some((c) => c.endsWith("/git/commits") && c.startsWith("POST"))).toBe(false);
    expect(calls.some((c) => c.includes("/git/refs/heads/"))).toBe(false);
  });

  it("still seeds a virgin auto_init repo (README only, no package.json)", async () => {
    const fetchFn = happyPathFetch({ baseTreeEntries: [{ path: "README.md" }] });
    const r = await seedTemplate("t1", "praxis-built/fresh", {
      token: () => "tok",
      fetchFn: fetchFn as never,
      files: FILES,
    });
    expect(r).toMatchObject({ seeded: true, commit_sha: "commit_new" });
  });

  it("resolves a non-main default branch and seeds onto IT", async () => {
    const fetchFn = happyPathFetch({ defaultBranch: "master" });
    const r = await seedTemplate("t1", "praxis-built/legacy", {
      token: () => "tok",
      fetchFn: fetchFn as never,
      files: FILES,
    });
    expect(r).toMatchObject({ seeded: true, branch: "master" });
    expect(fetchFn.mock.calls.some((c) => String(c[0]).includes("/git/ref/heads/master"))).toBe(true);
    const refCall = fetchFn.mock.calls.find((c) => String(c[0]).includes("/git/refs/heads/"));
    expect(String(refCall?.[0])).toContain("/git/refs/heads/master");
  });

  it("surfaces a GitHub error with status + body context", async () => {
    const fetchFn = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith("/git/trees") && init?.method === "POST") return res(422, { message: "boom" });
      if (url.includes("/git/trees/")) return res(200, { tree: [{ path: "README.md", type: "blob" }] });
      if (url.includes("/git/commits/")) return res(200, { tree: { sha: "tree_base" } });
      if (url.includes("/git/ref/heads/")) return res(200, { object: { sha: "commit_base" } });
      return res(200, { default_branch: "main" });
    });
    await expect(
      seedTemplate("t1", "praxis-built/acme", { token: () => "tok", fetchFn: fetchFn as never, files: FILES }),
    ).rejects.toThrow(/tree failed \(422\).*boom/i);
    expect(fetchFn.mock.calls.some((c) => String(c[0]).endsWith("/git/blobs"))).toBe(false);
    expect(fetchFn.mock.calls.some((c) => c[1]?.method === "PATCH")).toBe(false);
  });

  it("surfaces a binary-file blob error with status + body context before any tree write", async () => {
    const fetchFn = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith("/git/blobs")) return res(422, { message: "boom" });
      if (url.endsWith("/git/trees") && init?.method === "POST") return res(201, { sha: "tree_new" });
      if (url.includes("/git/trees/")) return res(200, { tree: [{ path: "README.md", type: "blob" }] });
      if (url.includes("/git/commits/")) return res(200, { tree: { sha: "tree_base" } });
      if (url.includes("/git/ref/heads/")) return res(200, { object: { sha: "commit_base" } });
      return res(200, { default_branch: "main" });
    });
    await expect(
      seedTemplate("t1", "praxis-built/acme", {
        token: () => "tok",
        fetchFn: fetchFn as never,
        files: { ...FILES, "img.bin": "\u0000" },
      }),
    ).rejects.toThrow(/blob img\.bin failed \(422\)/i);
    expect(fetchFn.mock.calls.some((c) => String(c[0]).endsWith("/git/trees") && c[1]?.method === "POST")).toBe(false);
  });
});

describe("isSeedTemplateEnabled", () => {
  it("ON by default when the flag is unset / empty (default-ON contract)", () => {
    expect(isSeedTemplateEnabled(() => undefined)).toBe(true);
    expect(isSeedTemplateEnabled(() => "")).toBe(true);
    expect(isSeedTemplateEnabled(() => "  ")).toBe(true);
  });
  it("ON for any value other than an explicit disable token", () => {
    expect(isSeedTemplateEnabled(() => "true")).toBe(true);
    expect(isSeedTemplateEnabled(() => "1")).toBe(true);
    expect(isSeedTemplateEnabled(() => "YES")).toBe(true);
    expect(isSeedTemplateEnabled(() => "on")).toBe(true);
  });
  it("OFF only when explicitly disabled (0/false/no/off, case/space-insensitive)", () => {
    expect(isSeedTemplateEnabled(() => "0")).toBe(false);
    expect(isSeedTemplateEnabled(() => "false")).toBe(false);
    expect(isSeedTemplateEnabled(() => "FALSE")).toBe(false);
    expect(isSeedTemplateEnabled(() => "no")).toBe(false);
    expect(isSeedTemplateEnabled(() => " off ")).toBe(false);
  });
});

describe("seedProvisionedRepo (default-ON; disable with PROVISION_SEED_TEMPLATE=0/false/no/off)", () => {
  it("no-op when the flag is explicitly OFF (does not call seed)", async () => {
    const seed = vi.fn();
    const r = await seedProvisionedRepo("t1", "praxis-built/acme", { enabled: () => false, seed: seed as never });
    expect(r).toEqual({ seeded: false, reason: "flag_off" });
    expect(seed).not.toHaveBeenCalled();
  });

  it("delegates to seedTemplate when the flag is ON", async () => {
    const seed = vi.fn(async () => ({ seeded: true, commit_sha: "c", branch: "main", file_count: 12 }));
    const r = await seedProvisionedRepo("t1", "praxis-built/acme", { enabled: () => true, seed: seed as never });
    expect(seed).toHaveBeenCalledWith("t1", "praxis-built/acme", expect.any(Object));
    expect(r).toMatchObject({ seeded: true, commit_sha: "c" });
  });

  it("captures (never throws) a missing-credential as a structured result", async () => {
    const seed = vi.fn(async () => {
      throw new CredentialNotConfigured("GITHUB_PROVISION_TOKEN");
    });
    const r = await seedProvisionedRepo("t1", "praxis-built/acme", { enabled: () => true, seed: seed as never });
    expect(r).toMatchObject({
      seeded: false,
      reason: "credential_not_configured",
      missing_key: "GITHUB_PROVISION_TOKEN",
    });
  });

  it("captures (never throws) an arbitrary error as a structured result", async () => {
    const seed = vi.fn(async () => {
      throw new Error("github 500");
    });
    const r = await seedProvisionedRepo("t1", "praxis-built/acme", { enabled: () => true, seed: seed as never });
    expect(r).toMatchObject({ seeded: false, reason: "error", error: "github 500" });
  });

  it("feeds the category-specific starter file map into seedTemplate (picker-driven via idea)", async () => {
    let captured: { files?: Record<string, string>; commitMessage?: string } = {};
    const seed = vi.fn(async (_t: string, _r: string, d: { files?: Record<string, string>; commitMessage?: string }) => {
      captured = { files: d.files, commitMessage: d.commitMessage };
      return { seeded: true as const, commit_sha: "c", branch: "main", file_count: Object.keys(d.files ?? {}).length };
    });
    const r = await seedProvisionedRepo("t1", "praxis-built/acme", {
      enabled: () => true,
      seed: seed as never,
      idea: "a simple to-do list",
    });
    expect(r).toMatchObject({ seeded: true, category: "todo" });
    expect(captured.files?.["app/components/TodoApp.tsx"]).toBeDefined();
    expect(captured.files?.["README.md"]).toMatch(/Built with \*\*Zavi\*\*/);
    expect(captured.files?.LICENSE).toMatch(/^MIT License/);
    expect(captured.files?.["render.yaml"]).toMatch(/buildCommand/);
    expect(captured.commitMessage).toContain("todo");
  });

  it("honors an explicit category override over the picker", async () => {
    let cat: string | undefined;
    const seed = vi.fn(async (_t: string, _r: string, d: { files?: Record<string, string> }) => {
      cat = d.files?.["app/components/Hero.tsx"] ? "landing-detected" : undefined;
      return { seeded: true as const, commit_sha: "c", branch: "main", file_count: 1 };
    });
    const r = await seedProvisionedRepo("t1", "praxis-built/acme", {
      enabled: () => true,
      seed: seed as never,
      idea: "blog with posts",
      category: "landing",
    });
    expect(r).toMatchObject({ seeded: true, category: "landing" });
    expect(cat).toBe("landing-detected");
  });

  it("falls back to 'generic' when neither idea nor category is provided", async () => {
    const seed = vi.fn(async () => ({ seeded: true as const, commit_sha: "c", branch: "main", file_count: 1 }));
    const r = await seedProvisionedRepo("t1", "praxis-built/acme", {
      enabled: () => true,
      seed: seed as never,
    });
    expect(r).toMatchObject({ seeded: true, category: "generic" });
  });

  it("caller-provided files win over the picker-built map (test override seam preserved)", async () => {
    const customFiles = { "custom/only.txt": "hello\n" };
    let captured: Record<string, string> | undefined;
    const seed = vi.fn(async (_t: string, _r: string, d: { files?: Record<string, string> }) => {
      captured = d.files;
      return { seeded: true as const, commit_sha: "c", branch: "main", file_count: 1 };
    });
    await seedProvisionedRepo("t1", "praxis-built/acme", {
      enabled: () => true,
      seed: seed as never,
      idea: "a simple to-do list",
      files: customFiles,
    });
    expect(captured).toEqual(customFiles);
    expect(captured?.["app/components/TodoApp.tsx"]).toBeUndefined();
  });
});
