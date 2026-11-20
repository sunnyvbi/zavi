
import { describe, it, expect, vi } from "vitest";
import { createSiteRepoOps } from "../site-repo";

type Res = { status: number; json: () => Promise<unknown>; text: () => Promise<string> };
const res = (status: number, body: unknown = {}): Res => ({ status, json: async () => body, text: async () => JSON.stringify(body) });

function ops(fetchFn: (url: string, init?: { method?: string }) => Promise<Res>) {
  return createSiteRepoOps({ token: () => "tok", org: () => "praxis-built", fetchFn: vi.fn(fetchFn) as never });
}

describe("site repo ops", () => {
  it("rebinds to an existing repo instead of creating a second one", async () => {
    const calls: string[] = [];
    const o = ops(async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return res(200, { full_name: "praxis-built/shop-abc123", default_branch: "main" });
    });
    const r = await o.ensureRepo("shop-abc123");
    expect(r.full_name).toBe("praxis-built/shop-abc123");
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(0);
  });

  it("a create that loses a race (422) rebinds to the repo that won", async () => {
    let gets = 0;
    const o = ops(async (_url, init) => {
      if (init?.method === "POST") return res(422, { message: "name already exists" });
      gets++;
      return gets === 1 ? res(404) : res(200, { full_name: "praxis-built/shop-abc123" });
    });
    expect((await o.ensureRepo("shop-abc123")).full_name).toBe("praxis-built/shop-abc123");
  });

  it("rejects an unsafe repo name before any call", async () => {
    const f = vi.fn();
    const o = ops(f as never);
    await expect(o.ensureRepo("../evil")).rejects.toThrow(/invalid repo name/);
    expect(f).not.toHaveBeenCalled();
  });

  it("delete refuses a repo outside the provisioning org and treats 404 as done", async () => {
    const o = ops(async () => res(404));
    await expect(o.deleteRepo("someone-else/app")).rejects.toThrow(/outside the provisioning org/);
    await expect(o.deleteRepo("praxis-built/shop-abc123")).resolves.toBeUndefined();
  });

  it("seed returns the new commit, or main's HEAD when an earlier attempt already seeded", async () => {
    const seeded = createSiteRepoOps({
      token: () => "tok",
      org: () => "praxis-built",
      seedFn: vi.fn(async () => ({ seeded: true as const, commit_sha: "c1", branch: "main", file_count: 1 })),
    });
    expect(await seeded.seed("t", "praxis-built/x", { a: "b" })).toBe("c1");
    const again = createSiteRepoOps({
      token: () => "tok",
      org: () => "praxis-built",
      seedFn: vi.fn(async () => ({ seeded: false as const, reason: "repo_not_empty" as const, branch: "main", file_count: 1 })),
      headSha: async () => "h1",
    });
    expect(await again.seed("t", "praxis-built/x", { a: "b" })).toBe("h1");
  });
});
