import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readProvisionedRepoHeadTree } from "@/services/provisioning/github-repo";

const SHA = "a".repeat(40);
const TREE = "b".repeat(40);
const prevToken = process.env.GITHUB_PROVISION_TOKEN;

beforeEach(() => {
  process.env.GITHUB_PROVISION_TOKEN = "ghp_test";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (prevToken === undefined) delete process.env.GITHUB_PROVISION_TOKEN;
  else process.env.GITHUB_PROVISION_TOKEN = prevToken;
});

function respond(map: Record<string, { status: number; body: unknown }>) {
  const fetch = vi.fn(async (url: string) => {
    const key = Object.keys(map).find((k) => url.endsWith(k));
    const r = key ? map[key] : { status: 404, body: {} };
    return { ok: r.status < 300, status: r.status, json: async () => r.body } as Response;
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("readProvisionedRepoHeadTree", () => {
  it("reads main's head, then that commit's tree", async () => {
    const fetch = respond({
      "/git/ref/heads/main": { status: 200, body: { object: { sha: SHA } } },
      [`/git/commits/${SHA}`]: { status: 200, body: { sha: SHA, tree: { sha: TREE } } },
    });
    expect(await readProvisionedRepoHeadTree("Org/site")).toEqual({ sha: SHA, tree: TREE });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("says why when the commit read fails, and never throws", async () => {
    respond({ "/git/ref/heads/main": { status: 200, body: { object: { sha: SHA } } } });
    expect(await readProvisionedRepoHeadTree("Org/site")).toEqual({ error: expect.stringContaining("404") });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    expect(await readProvisionedRepoHeadTree("Org/site")).toEqual({ error: expect.stringContaining("could not be reached") });
  });

  it("without a credential it reads nothing", async () => {
    delete process.env.GITHUB_PROVISION_TOKEN;
    const fetch = respond({});
    expect("error" in (await readProvisionedRepoHeadTree("Org/site"))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
