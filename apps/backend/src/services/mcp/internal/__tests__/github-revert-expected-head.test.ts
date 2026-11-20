import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/connectors/github/oauth", () => ({
  mintInstallationToken: vi.fn(async () => "ghs_faketoken"),
  ghInstallationHeaders: vi.fn(() => ({ authorization: "Bearer ghp_fake" })),
}));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));

import { AUTOPILOT_PAT_SENTINEL, revertCommitOnMain } from "../github";

type Commit = { parents: string[]; tree: string; message: string };

const BASE = "1".repeat(40);
const EDIT = "2".repeat(40);
const HOTFIX = "3".repeat(40);

let commits: Map<string, Commit>;
let mainRef: string;
let writes: Array<{ method: string; url: string; body: Record<string, unknown> }>;
let onCommitCreated: (() => void) | null;
let seq: number;

function isAncestor(a: string, b: string): boolean {
  const stack = [b];
  while (stack.length) {
    const c = stack.pop()!;
    if (c === a) return true;
    stack.push(...(commits.get(c)?.parents ?? []));
  }
  return false;
}

function reply(status: number, obj: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    headers: new Headers(),
  } as unknown as Response;
}

function installGithub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const commitGet = url.match(/\/git\/commits\/([0-9a-f]+)$/);
      if (method === "GET" && commitGet) {
        const c = commits.get(commitGet[1]);
        return c
          ? reply(200, { sha: commitGet[1], parents: c.parents.map((sha) => ({ sha })), message: c.message, tree: { sha: c.tree } })
          : reply(404, {});
      }
      if (method === "GET" && /\/git\/ref\/heads\/main$/.test(url)) return reply(200, { object: { sha: mainRef } });
      if (method === "POST" && /\/git\/commits$/.test(url)) {
        writes.push({ method, url, body });
        const sha = (++seq).toString(16).padStart(40, "a");
        commits.set(sha, { parents: body.parents as string[], tree: String(body.tree), message: String(body.message) });
        onCommitCreated?.();
        return reply(201, { sha });
      }
      if (method === "PATCH" && /\/git\/refs\/heads\/main$/.test(url)) {
        writes.push({ method, url, body });
        const to = String(body.sha);
        if (body.force !== false) return reply(500, { message: "test only accepts non-force updates" });
        if (!isAncestor(mainRef, to)) return reply(422, { message: "Update is not a fast forward" });
        mainRef = to;
        return reply(200, { object: { sha: to } });
      }
      return reply(500, { message: `unexpected ${method} ${url}` });
    }),
  );
}

function revert(expected_head_sha?: string) {
  return revertCommitOnMain({
    tenant_id: "tnt-yoga",
    installation_id: AUTOPILOT_PAT_SENTINEL,
    owner: "Praxis-build",
    repo: "yoga-flow",
    base_branch: "main",
    commit_sha: EDIT,
    ...(expected_head_sha !== undefined ? { expected_head_sha } : {}),
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  process.env.GITHUB_PROVISION_TOKEN = "ghp_fake";
  process.env.PRAXIS_GITHUB_ORG = "Praxis-build";
  commits = new Map([
    [BASE, { parents: [], tree: "tree-base", message: "initial build" }],
    [EDIT, { parents: [BASE], tree: "tree-edit", message: "sage green" }],
    [HOTFIX, { parents: [EDIT], tree: "tree-hotfix", message: "hotfix" }],
  ]);
  mainRef = EDIT;
  writes = [];
  onCommitCreated = null;
  seq = 0;
  installGithub();
});

describe("revertCommitOnMain with expected_head_sha (DEL-1323 B29)", () => {
  it("reverts on top of the expected head with a non-force update", async () => {
    const out = await revert(EDIT);
    const created = commits.get(out.new_commit_sha)!;
    expect(created.parents).toEqual([EDIT]);
    expect(created.tree).toBe("tree-base");
    expect(mainRef).toBe(out.new_commit_sha);
    expect(writes.find((w) => w.method === "PATCH")!.body).toEqual({ sha: out.new_commit_sha, force: false });
  });

  it("a push that already landed before the revert refuses with revert_head_moved and writes nothing", async () => {
    mainRef = HOTFIX;
    await expect(revert(EDIT)).rejects.toMatchObject({ code: "revert_head_moved" });
    expect(writes).toEqual([]);
    expect(mainRef).toBe(HOTFIX);
  });

  it("a push landing after the revert commit is built is rejected by the ref update, and main keeps it", async () => {
    onCommitCreated = () => {
      onCommitCreated = null;
      mainRef = HOTFIX;
    };
    await expect(revert(EDIT)).rejects.toMatchObject({ code: "fast_forward_rejected" });
    expect(mainRef).toBe(HOTFIX);
  });

  it("without an expected head it keeps the old behaviour and reverts on top of whatever main is", async () => {
    mainRef = HOTFIX;
    const out = await revert();
    expect(commits.get(out.new_commit_sha)!.parents).toEqual([HOTFIX]);
    expect(mainRef).toBe(out.new_commit_sha);
  });
});
