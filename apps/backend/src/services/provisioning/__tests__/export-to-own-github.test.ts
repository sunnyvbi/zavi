import { describe, it, expect, vi } from "vitest";
import {
  DestRepoMissing,
  exportRepoToOwnGitHub,
  bareRepoName,
  EXPORT_BLOB_CONCURRENCY,
  EXPORT_WRITE_CONCURRENCY,
} from "@/services/provisioning/export-to-own-github";
import { CredentialNotConfigured } from "@/services/provisioning/github-repo";

function res(status: number, body: unknown = {}) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

const SRC_FILES: Record<string, string> = {
  "package.json": '{"name":"acme-app"}\n',
  "app/page.tsx": "export default function Page(){return null}\n",
};

const SRC_TREE_SHA = "src_tree";
const SRC_COMMIT_SHA = "src_commit";

function buildFetch(opts: {
  destExists?: boolean;
  destAccountType?: string;
  newDestTreeSha?: string;
  destBaseTreeSha?: string;
  destDefaultBranch?: string;
  srcDefaultBranch?: string;
  srcTruncated?: boolean;
  destMovesUnderUs?: boolean;
  srcFiles?: Record<string, string>;
  destEmpty?: boolean;
  destRootPaths?: string[];
  destHistory?: string[];
  orgCreateStatus?: number;
  srcModes?: Record<string, string>;
} = {}) {
  const srcFiles = opts.srcFiles ?? SRC_FILES;
  const srcPaths = Object.keys(srcFiles);
  const newDestTree = opts.newDestTreeSha ?? "dest_tree_new";
  const destBaseTree = opts.destBaseTreeSha ?? "dest_tree_base";
  const destBranch = opts.destDefaultBranch ?? "main";
  const srcBranch = opts.srcDefaultBranch ?? "main";
  let destHeadTree = destBaseTree;
  let destHeadCommit = "dest_commit_base";
  let destIsEmpty = !!opts.destEmpty;
  const blobShaByPath = new Map<string, string>();
  let srcBlobIdx = 0;

  const srcTreeEntries = srcPaths.map((path) => ({
    path,
    mode: opts.srcModes?.[path] ?? "100644",
    type: "blob" as const,
    sha: `srcblob_${path}`,
  }));

  const fetchFn = vi.fn(
    async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const method = init?.method ?? "GET";
      const auth = init?.headers?.Authorization ?? init?.headers?.authorization ?? "";
      const isUmbrella = auth.startsWith("Bearer ");
      const isInstall = auth.startsWith("token ");

      if (isUmbrella) {
        if (method === "GET" && /\/git\/trees\//.test(url)) {
          return res(200, { tree: srcTreeEntries, truncated: !!opts.srcTruncated });
        }
        if (method === "GET" && /\/git\/blobs\//.test(url)) {
          const sha = url.split("/git/blobs/")[1];
          const path = srcPaths.find((p) => `srcblob_${p}` === sha) ?? srcPaths[srcBlobIdx++];
          return res(200, {
            content: Buffer.from(srcFiles[path], "utf-8").toString("base64"),
            encoding: "base64",
          });
        }
        if (method === "GET" && /\/git\/commits\//.test(url)) {
          return res(200, { tree: { sha: SRC_TREE_SHA } });
        }
        if (method === "GET" && /\/git\/ref\/heads\//.test(url)) {
          return res(200, { object: { sha: SRC_COMMIT_SHA } });
        }
        if (method === "GET") {
          return res(200, { default_branch: srcBranch });
        }
      }

      if (isInstall) {
        if (method === "GET" && /\/repos\/[^/]+\/[^/]+$/.test(url)) {
          if (opts.destExists) {
            return res(200, {
              full_name: "acme-co/acme-app",
              html_url: "https://github.com/acme-co/acme-app",
              default_branch: destBranch,
            });
          }
          return repoCreated ? res(200, { full_name: "acme-co/acme-app", html_url: "https://github.com/acme-co/acme-app", default_branch: destBranch }) : res(404, { message: "Not Found" });
        }
        if (method === "POST" && /\/orgs\/[^/]+\/repos$/.test(url)) {
          if (opts.orgCreateStatus) {
            return res(opts.orgCreateStatus, { message: "Resource not accessible by integration" });
          }
          repoCreated = true;
          return res(201, {
            full_name: "acme-co/acme-app",
            html_url: "https://github.com/acme-co/acme-app",
            default_branch: destBranch,
          });
        }
        if (method === "POST" && url.endsWith("/git/blobs")) {
          const body = JSON.parse(init?.body ?? "{}");
          const sha = `destblob_${blobShaByPath.size}`;
          blobShaByPath.set(sha, body.content);
          return res(201, { sha });
        }
        if (method === "POST" && url.endsWith("/git/trees")) {
          return res(201, { sha: newDestTree });
        }
        if (method === "POST" && url.endsWith("/git/commits")) {
          destHeadCommit = "dest_commit_new";
          destHeadTree = newDestTree;
          return res(201, { sha: destHeadCommit });
        }
        if (method === "PUT" && /\/contents\//.test(url)) {
          destIsEmpty = false;
          destHeadCommit = "dest_commit_seed";
          destHeadTree = "dest_tree_seed";
          return res(201, { commit: { sha: destHeadCommit } });
        }
        if (method === "GET" && /\/git\/trees\//.test(url)) {
          return res(200, { tree: (opts.destRootPaths ?? ["README.md"]).map((path) => ({ path })) });
        }
        if (method === "GET" && /\/commits\?/.test(url)) {
          return res(
            200,
            (opts.destHistory ?? ["Initial commit"]).map((message) => ({ commit: { message } })),
          );
        }
        if (method === "PATCH" && /\/git\/refs\/heads\//.test(url)) {
          if (opts.destMovesUnderUs) {
            return res(422, { message: "Update is not a fast forward" });
          }
          return res(200, { object: { sha: destHeadCommit } });
        }
        if (method === "GET" && /\/git\/ref\/heads\//.test(url)) {
          if (destIsEmpty) return res(409, { message: "Git Repository is empty." });
          return res(200, { object: { sha: destHeadCommit } });
        }
        if (method === "GET" && /\/git\/commits\//.test(url)) {
          return res(200, { tree: { sha: destHeadTree } });
        }
      }

      throw new Error(`unexpected fetch ${method} ${url} auth=${auth}`);
    },
  );
  let repoCreated = opts.destExists ?? false;
  (fetchFn as unknown as { _destBlobs: Map<string, string> })._destBlobs = blobShaByPath;
  return fetchFn;
}

const baseInput = {
  tenant_id: "t1",
  source_full_name: "praxis-built/acme-app-12345678",
  dest_owner: "acme-co",
  dest_account_type: "Organization",
  installation_id: 999,
};

const baseDeps = {
  umbrellaToken: () => "umbrella_tok",
  mintInstallationToken: vi.fn(async () => "install_tok"),
};

describe("exportRepoToOwnGitHub", () => {
  it("THROWS CredentialNotConfigured when the umbrella token is missing", async () => {
    await expect(
      exportRepoToOwnGitHub(baseInput, {
        ...baseDeps,
        umbrellaToken: () => null,
        fetchFn: vi.fn() as never,
      }),
    ).rejects.toBeInstanceOf(CredentialNotConfigured);
  });

  it("rejects a malformed source_full_name", async () => {
    await expect(
      exportRepoToOwnGitHub(
        { ...baseInput, source_full_name: "no-slash" },
        { ...baseDeps, fetchFn: vi.fn() as never },
      ),
    ).rejects.toThrow(/invalid source_full_name/i);
  });

  it("rejects a missing dest_owner (GitHub not connected)", async () => {
    await expect(
      exportRepoToOwnGitHub(
        { ...baseInput, dest_owner: "" },
        { ...baseDeps, fetchFn: vi.fn() as never },
      ),
    ).rejects.toThrow(/dest_owner is required/i);
  });

  it("EXPORTS: targets the USER'S org, mints the user's installation token, creates the dest repo, pushes the tree, verifies", async () => {
    const fetchFn = buildFetch();
    const mint = vi.fn(async () => "install_tok");
    const r = await exportRepoToOwnGitHub(baseInput, {
      ...baseDeps,
      mintInstallationToken: mint,
      fetchFn: fetchFn as never,
    });

    expect(r.exported).toBe(true);
    if (r.exported) {
      expect(r.source_sha).toBe(SRC_COMMIT_SHA);
      expect(r.dest_full_name).toBe("acme-co/acme-app");
      expect(r.dest_url).toBe("https://github.com/acme-co/acme-app");
      expect(r.file_count).toBe(2);
      expect(r.created_dest_repo).toBe(true);
      expect(r.commit_sha).toBe("dest_commit_new");
    }

    expect(mint).toHaveBeenCalledWith({ tenant_id: "t1", installation_id: 999 });

    const calls = fetchFn.mock.calls.map((c) => `${c[1]?.method ?? "GET"} ${c[0]}`);
    expect(calls).toContain("POST https://api.github.com/orgs/acme-co/repos");
    expect(calls.some((c) => c.includes("/repos/praxis-built/acme-app-12345678"))).toBe(true);
    const createCall = fetchFn.mock.calls.find((c) =>
      String(c[0]).endsWith("/orgs/acme-co/repos"),
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      name: "acme-app-12345678",
      private: true,
    });
  });

  it("CONTENT MATCHES: each source file's bytes are pushed to the dest unchanged", async () => {
    const fetchFn = buildFetch();
    await exportRepoToOwnGitHub(baseInput, { ...baseDeps, fetchFn: fetchFn as never });

    const destBlobBodies = fetchFn.mock.calls
      .filter((c) => String(c[0]).endsWith("/git/blobs") && (c[1]?.method ?? "GET") === "POST")
      .map((c) => JSON.parse(String(c[1]?.body)) as { content: string; encoding: string });
    expect(destBlobBodies).toHaveLength(2);
    const decoded = destBlobBodies.map((b) => Buffer.from(b.content, "base64").toString("utf-8"));
    expect(decoded).toContain(SRC_FILES["package.json"]);
    expect(decoded).toContain(SRC_FILES["app/page.tsx"]);
    for (const b of destBlobBodies) expect(b.encoding).toBe("base64");
  });

  it("KEEPS FILE MODES: an executable script stays executable and a symlink stays a symlink", async () => {
    const fetchFn = buildFetch({
      srcFiles: { ...SRC_FILES, "scripts/migrate.sh": "#!/bin/sh\necho ok\n", "public/logo.svg": "assets/logo.svg" },
      srcModes: { "scripts/migrate.sh": "100755", "public/logo.svg": "120000" },
    });
    await exportRepoToOwnGitHub(baseInput, { ...baseDeps, fetchFn: fetchFn as never });

    const treeCall = fetchFn.mock.calls.find((c) => String(c[0]).endsWith("/git/trees") && c[1]?.method === "POST");
    const entries = (JSON.parse(String(treeCall?.[1]?.body)) as { tree: Array<{ path: string; mode: string }> }).tree;
    const modeOf = Object.fromEntries(entries.map((e) => [e.path, e.mode]));
    expect(modeOf).toEqual({
      "package.json": "100644",
      "app/page.tsx": "100644",
      "scripts/migrate.sh": "100755",
      "public/logo.svg": "120000",
    });
  });

  it("READS the source in parallel but WRITES to the founder's repo one blob at a time, keeping the tree in source order", async () => {
    const srcFiles = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`src/f${String(i).padStart(2, "0")}.ts`, `export const v${i} = ${i};\n`]));
    const inner = buildFetch({ srcFiles });
    let inFlight = 0;
    let peak = 0;
    let writesInFlight = 0;
    let writePeak = 0;
    const fetchFn = vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      if (!/\/git\/blobs/.test(url)) return inner(url, init);
      const write = init?.method === "POST";
      if (write) writePeak = Math.max(writePeak, ++writesInFlight);
      else peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await inner(url, init);
      } finally {
        if (write) writesInFlight -= 1;
        else inFlight -= 1;
      }
    });
    const r = await exportRepoToOwnGitHub(baseInput, { ...baseDeps, fetchFn: fetchFn as never });
    expect(r.exported).toBe(true);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(EXPORT_BLOB_CONCURRENCY);
    expect(writePeak).toBe(EXPORT_WRITE_CONCURRENCY);
    expect(EXPORT_WRITE_CONCURRENCY).toBe(1);
    const treeCall = fetchFn.mock.calls.find((c) => String(c[0]).endsWith("/git/trees") && c[1]?.method === "POST");
    const paths = (JSON.parse(String(treeCall?.[1]?.body)) as { tree: Array<{ path: string }> }).tree.map((e) => e.path);
    expect(paths).toEqual(Object.keys(srcFiles));
    const decoded = fetchFn.mock.calls
      .filter((c) => String(c[0]).endsWith("/git/blobs") && c[1]?.method === "POST")
      .map((c) => Buffer.from(JSON.parse(String(c[1]?.body)).content, "base64").toString("utf-8"));
    expect(new Set(decoded)).toEqual(new Set(Object.values(srcFiles)));
  });

  it("IDEMPOTENT: when the rebuilt dest tree equals the dest base tree, skips commit + ref (already_exported)", async () => {
    const fetchFn = buildFetch({
      destExists: true,
      newDestTreeSha: "dest_tree_base",
      destBaseTreeSha: "dest_tree_base",
    });
    const r = await exportRepoToOwnGitHub(baseInput, { ...baseDeps, fetchFn: fetchFn as never });
    expect(r.exported).toBe(false);
    if (!r.exported) {
      expect(r.reason).toBe("already_exported");
      expect(r.source_sha).toBe(SRC_COMMIT_SHA);
      expect(r.created_dest_repo).toBe(false);
    }
    const calls = fetchFn.mock.calls.map((c) => `${c[1]?.method ?? "GET"} ${c[0]}`);
    expect(calls.some((c) => c.endsWith("/git/commits") && c.startsWith("POST"))).toBe(false);
    expect(calls.some((c) => /PATCH .*\/git\/refs\/heads\//.test(c))).toBe(false);
    expect(calls.some((c) => c.endsWith("/orgs/acme-co/repos"))).toBe(false);
  });

  it("REUSES an existing dest repo (read-before-create) instead of creating a new one", async () => {
    const fetchFn = buildFetch({ destExists: true });
    const r = await exportRepoToOwnGitHub(baseInput, { ...baseDeps, fetchFn: fetchFn as never });
    expect(r.exported).toBe(true);
    if (r.exported) expect(r.created_dest_repo).toBe(false);
    const calls = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.endsWith("/orgs/acme-co/repos"))).toBe(false);
  });

  it("FAILS CLEAN for a personal (User) account with no pre-created repo", async () => {
    const fetchFn = buildFetch({ destAccountType: "User", destExists: false });
    await expect(
      exportRepoToOwnGitHub(
        { ...baseInput, dest_account_type: "User" },
        { ...baseDeps, fetchFn: fetchFn as never },
      ),
    ).rejects.toThrow(/dest_user_repo_must_exist/);
  });

  it("USER account WITH a pre-existing repo exports fine (no create needed)", async () => {
    const fetchFn = buildFetch({ destAccountType: "User", destExists: true });
    const r = await exportRepoToOwnGitHub(
      { ...baseInput, dest_account_type: "User" },
      { ...baseDeps, fetchFn: fetchFn as never },
    );
    expect(r.exported).toBe(true);
  });

  it("EMPTY dest repo: seeds a first commit through the Contents API, then mirrors the source onto it", async () => {
    const fetchFn = buildFetch({ destAccountType: "User", destExists: true, destEmpty: true });
    const r = await exportRepoToOwnGitHub(
      { ...baseInput, dest_account_type: "User" },
      { ...baseDeps, fetchFn: fetchFn as never },
    );
    expect(r.exported).toBe(true);
    if (r.exported) expect(r.commit_sha).toBe("dest_commit_new");

    const calls = fetchFn.mock.calls.map((c) => `${c[1]?.method ?? "GET"} ${c[0]}`);
    const seedIdx = calls.findIndex((c) => c.startsWith("PUT ") && c.includes("/contents/"));
    const firstBlobIdx = calls.findIndex((c) => c.startsWith("POST ") && c.endsWith("/git/blobs"));
    expect(seedIdx).toBeGreaterThan(-1);
    expect(firstBlobIdx).toBeGreaterThan(seedIdx);
    expect(calls[seedIdx]).toBe("PUT https://api.github.com/repos/acme-co/acme-app/contents/package.json");
    const seedBody = JSON.parse(String(fetchFn.mock.calls[seedIdx][1]?.body));
    expect(Buffer.from(seedBody.content, "base64").toString("utf-8")).toBe(SRC_FILES["package.json"]);

    const commitCall = fetchFn.mock.calls.find(
      (c) => String(c[0]).endsWith("/git/commits") && c[1]?.method === "POST",
    );
    expect(JSON.parse(String(commitCall?.[1]?.body)).parents).toEqual(["dest_commit_seed"]);
    const treeCall = fetchFn.mock.calls.find(
      (c) => String(c[0]).endsWith("/git/trees") && c[1]?.method === "POST",
    );
    expect(JSON.parse(String(treeCall?.[1]?.body))).not.toHaveProperty("base_tree");
  });

  it("REFUSES to replace a repo that already holds the founder's own code, and writes nothing to it", async () => {
    const fetchFn = buildFetch({
      destAccountType: "User",
      destExists: true,
      destRootPaths: ["README.md", "src", "package.json"],
      destHistory: ["Add login page", "Initial commit"],
    });
    await expect(
      exportRepoToOwnGitHub(
        { ...baseInput, dest_account_type: "User" },
        { ...baseDeps, fetchFn: fetchFn as never },
      ),
    ).rejects.toThrow(/^dest_repo_not_empty: .*src, package\.json/);
    const writes = fetchFn.mock.calls.filter((c) => (c[1]?.method ?? "GET") !== "GET");
    expect(writes).toEqual([]);
  });

  it("re-exports into a repo Zavi exported to before, when the last commit is still Zavi's export", async () => {
    const fetchFn = buildFetch({
      destExists: true,
      destRootPaths: ["package.json", "app"],
      destHistory: ["chore: export product from Praxis (migrate to own GitHub)", "Initial commit"],
    });
    const r = await exportRepoToOwnGitHub(baseInput, { ...baseDeps, fetchFn: fetchFn as never });
    expect(r.exported).toBe(true);
  });

  it("REFUSES to re-export over commits the founder made after the last export, and writes nothing", async () => {
    const fetchFn = buildFetch({
      destExists: true,
      destRootPaths: ["package.json", "app"],
      destHistory: [
        "Add pricing page",
        "Tweak copy",
        "chore: export product from Praxis (migrate to own GitHub)",
        "Initial commit",
      ],
    });
    await expect(
      exportRepoToOwnGitHub(baseInput, { ...baseDeps, fetchFn: fetchFn as never }),
    ).rejects.toThrow(/^dest_repo_changed_since_export: .*has 2 commits on main since Zavi's last export/);
    const writes = fetchFn.mock.calls.filter((c) => (c[1]?.method ?? "GET") !== "GET");
    expect(writes).toEqual([]);
    const umbrellaCalls = fetchFn.mock.calls.filter((c) =>
      String(c[1]?.headers?.Authorization ?? "").startsWith("Bearer "),
    );
    expect(umbrellaCalls.length).toBeGreaterThan(0);
  });

  it("a missing personal repo fails before a single source blob is downloaded", async () => {
    const fetchFn = buildFetch({ destAccountType: "User", destExists: false });
    await expect(
      exportRepoToOwnGitHub(
        { ...baseInput, dest_account_type: "User" },
        { ...baseDeps, fetchFn: fetchFn as never },
      ),
    ).rejects.toThrow(/dest_user_repo_must_exist/);
    const umbrellaCalls = fetchFn.mock.calls.filter((c) =>
      String(c[1]?.headers?.Authorization ?? "").startsWith("Bearer "),
    );
    expect(umbrellaCalls).toEqual([]);
  });

  it("a missing personal repo names the exact owner and repo the founder must create", async () => {
    const fetchFn = buildFetch({ destAccountType: "User", destExists: false });
    const err = await exportRepoToOwnGitHub(
      { ...baseInput, dest_owner: "mohit-upcar", dest_account_type: "User", dest_repo_name: "my-site" },
      { ...baseDeps, fetchFn: fetchFn as never },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DestRepoMissing);
    expect(err).toMatchObject({ owner: "mohit-upcar", repo_name: "my-site" });
    expect(fetchFn.mock.calls.filter((c) => (c[1]?.method ?? "GET") !== "GET")).toEqual([]);
  });

  it("an org that refuses the create (no Administration permission) gets the same create-it-yourself path, before any source read", async () => {
    for (const status of [403, 404]) {
      const fetchFn = buildFetch({ destExists: false, orgCreateStatus: status });
      const err = await exportRepoToOwnGitHub(baseInput, { ...baseDeps, fetchFn: fetchFn as never }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DestRepoMissing);
      expect(err).toMatchObject({ owner: "acme-co", repo_name: "acme-app-12345678" });
      const umbrellaCalls = fetchFn.mock.calls.filter((c) =>
        String(c[1]?.headers?.Authorization ?? "").startsWith("Bearer "),
      );
      expect(umbrellaCalls).toEqual([]);
    }
  });

  it("an org create failing for any other reason still surfaces GitHub's error, not a create-it-yourself prompt", async () => {
    const fetchFn = buildFetch({ destExists: false, orgCreateStatus: 422 });
    const err = await exportRepoToOwnGitHub(baseInput, { ...baseDeps, fetchFn: fetchFn as never }).catch(
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(DestRepoMissing);
    expect(String((err as Error).message)).toMatch(/export dest repo create failed \(422\)/);
  });

  it("never force-moves the founder's branch: a commit pushed while the export ran turns into a changed-since-export conflict, not a lost commit", async () => {
    const fetchFn = buildFetch({ destMovesUnderUs: true });
    await expect(
      exportRepoToOwnGitHub(baseInput, { ...baseDeps, mintInstallationToken: async () => "install_tok", fetchFn: fetchFn as never }),
    ).rejects.toThrow(/^dest_repo_changed_since_export/);
    const patch = fetchFn.mock.calls.find((c) => c[1]?.method === "PATCH" && /\/git\/refs\/heads\//.test(String(c[0])));
    expect(patch).toBeTruthy();
    expect(JSON.parse(String(patch![1]?.body))).toMatchObject({ force: false });
  });

  it("REFUSES a truncated (too-large) source tree rather than exporting a partial copy", async () => {
    const fetchFn = buildFetch({ srcTruncated: true });
    await expect(
      exportRepoToOwnGitHub(baseInput, { ...baseDeps, fetchFn: fetchFn as never }),
    ).rejects.toThrow(/truncated/i);
  });

  it("derives the dest repo NAME from the source bare name by default", async () => {
    const fetchFn = buildFetch();
    await exportRepoToOwnGitHub(baseInput, { ...baseDeps, fetchFn: fetchFn as never });
    const createCall = fetchFn.mock.calls.find((c) => String(c[0]).endsWith("/orgs/acme-co/repos"));
    expect(JSON.parse(String(createCall?.[1]?.body)).name).toBe("acme-app-12345678");
  });

  it("honors an explicit dest_repo_name override", async () => {
    const fetchFn = buildFetch();
    await exportRepoToOwnGitHub(
      { ...baseInput, dest_repo_name: "my-shiny-app" },
      { ...baseDeps, fetchFn: fetchFn as never },
    );
    const createCall = fetchFn.mock.calls.find((c) => String(c[0]).endsWith("/orgs/acme-co/repos"));
    expect(JSON.parse(String(createCall?.[1]?.body)).name).toBe("my-shiny-app");
  });

  it("surfaces a GitHub error from the source read with status + context", async () => {
    const fetchFn = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      const auth = init?.headers?.Authorization ?? "";
      if (auth.startsWith("Bearer ")) return res(503, { message: "github down" });
      return res(200, {});
    });
    await expect(
      exportRepoToOwnGitHub(baseInput, { ...baseDeps, fetchFn: fetchFn as never }),
    ).rejects.toThrow(/source repo lookup failed \(503\)/i);
  });
});

describe("bareRepoName", () => {
  it("extracts the repo name from owner/repo", () => {
    expect(bareRepoName("praxis-built/acme-app-12345678")).toBe("acme-app-12345678");
    expect(bareRepoName("just-a-name")).toBe("just-a-name");
    expect(bareRepoName("")).toBe("");
  });
});
