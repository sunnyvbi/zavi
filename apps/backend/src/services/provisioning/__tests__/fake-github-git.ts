import { vi } from "vitest";
import { createHash } from "node:crypto";

export type Files = Record<string, string>;
type TreeEntry = { path: string; content?: string; sha?: string };

function res(status: number, body: unknown = {}) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

export function fakeGitHub(opts: { initial: Files; moveHeadBeforePatch?: boolean; failOn?: "tree" | "commit" | "patch" }) {
  const blobs = new Map<string, string>();
  const trees = new Map<string, Files>();
  const commits = new Map<string, { tree: string; parents: string[] }>();
  const hashTree = (f: Files) =>
    "t_" + createHash("sha1").update(JSON.stringify(Object.keys(f).sort().map((k) => [k, f[k]]))).digest("hex").slice(0, 10);
  const putTree = (f: Files) => {
    const sha = hashTree(f);
    trees.set(sha, f);
    return sha;
  };
  commits.set("c_old", { tree: putTree(opts.initial), parents: [] });
  const state = { head: "c_old", treeCalls: [] as Array<{ base_tree?: string; tree: TreeEntry[] }>, commitCalls: [] as Array<{ tree: string; parents: string[] }>, patchCalls: [] as Array<{ sha: string; force: boolean }> };
  let n = 0;
  const fetchFn = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (method === "GET" && /\/git\/ref\/heads\//.test(url)) return res(200, { object: { sha: state.head } });
    if (method === "GET" && /\/git\/commits\//.test(url)) {
      const c = commits.get(url.split("/").pop()!);
      return c ? res(200, { tree: { sha: c.tree } }) : res(404);
    }
    if (method === "GET" && /\/git\/trees\//.test(url)) {
      const t = trees.get(url.split("/").pop()!) ?? {};
      return res(200, { tree: Object.keys(t).filter((p) => !p.includes("/")).map((p) => ({ path: p, type: "blob" })) });
    }
    if (method === "GET") return res(200, { default_branch: "main" });
    if (method === "POST" && url.endsWith("/git/blobs")) {
      const sha = `b_${n++}`;
      blobs.set(sha, Buffer.from(body.content, "base64").toString("utf-8"));
      return res(201, { sha });
    }
    if (method === "POST" && url.endsWith("/git/trees")) {
      state.treeCalls.push(body);
      if (opts.failOn === "tree") return res(500, { message: "boom" });
      const merged: Files = body.base_tree ? { ...(trees.get(body.base_tree) ?? {}) } : {};
      for (const e of body.tree as TreeEntry[]) merged[e.path] = e.content ?? blobs.get(e.sha!) ?? "";
      return res(201, { sha: putTree(merged) });
    }
    if (method === "POST" && url.endsWith("/git/commits")) {
      state.commitCalls.push(body);
      if (opts.failOn === "commit") return res(500, { message: "boom" });
      const sha = `c_${n++}`;
      commits.set(sha, { tree: body.tree, parents: body.parents });
      return res(201, { sha });
    }
    if (method === "PATCH" && /\/git\/refs\/heads\//.test(url)) {
      state.patchCalls.push(body);
      if (opts.moveHeadBeforePatch) state.head = "c_concurrent";
      if (opts.failOn === "patch") return res(500, { message: "boom" });
      const c = commits.get(body.sha);
      if (!body.force && !c?.parents.includes(state.head)) return res(422, { message: "Update is not a fast forward" });
      state.head = body.sha;
      return res(200, { object: { sha: body.sha } });
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  const headFiles = () => trees.get(commits.get(state.head)!.tree)!;
  return { fetchFn, state, headFiles, commits };
}

