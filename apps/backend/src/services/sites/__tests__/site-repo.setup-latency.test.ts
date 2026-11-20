import { describe, it, expect, vi } from "vitest";
import { createSiteRepoOps } from "../site-repo";
import type { seedTemplate } from "@/services/provisioning/seed-template";

type Res = { status: number; json: () => Promise<unknown>; text: () => Promise<string> };
const res = (status: number, body: unknown = {}): Res => ({ status, json: async () => body, text: async () => JSON.stringify(body) });

describe("site repo ops setup latency", () => {
  it("seed hands the default branch it was given to the seeder, and omits it when not given", async () => {
    const seedFn = vi.fn<Parameters<typeof seedTemplate>, ReturnType<typeof seedTemplate>>(async () => ({
      seeded: true as const,
      commit_sha: "c1",
      branch: "trunk",
      file_count: 1,
    }));
    const o = createSiteRepoOps({ token: () => "tok", org: () => "praxis-built", seedFn });
    expect(await o.seed("t", "praxis-built/x", { a: "b" }, { default_branch: "trunk" })).toBe("c1");
    expect(seedFn.mock.calls[0][2]).toMatchObject({ defaultBranch: "trunk", files: { a: "b" } });
    await o.seed("t", "praxis-built/x", { a: "b" });
    expect(seedFn.mock.calls[1][2]).not.toHaveProperty("defaultBranch");
  });

  it("a created repo that never becomes readable fails after 3 reads without a pointless last wait", async () => {
    const waits: number[] = [];
    let reads = 0;
    const o = createSiteRepoOps({
      token: () => "tok",
      org: () => "praxis-built",
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchFn: (async (_url: string, init?: { method?: string }) => {
        if (init?.method === "POST") return res(201, { full_name: "praxis-built/shop" });
        reads++;
        return res(404);
      }) as never,
    });
    await expect(o.ensureRepo("shop")).rejects.toThrow(/not reachable after create/);
    expect(reads).toBe(4);
    expect(waits).toEqual([200, 400]);
  });

  it("a created repo that becomes readable on the third read waits 200 then 400 ms and returns its default branch", async () => {
    const waits: number[] = [];
    let reads = 0;
    const o = createSiteRepoOps({
      token: () => "tok",
      org: () => "praxis-built",
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchFn: (async (_url: string, init?: { method?: string }) => {
        if (init?.method === "POST") return res(201, {});
        reads++;
        return reads < 4 ? res(404) : res(200, { full_name: "praxis-built/shop", default_branch: "trunk", html_url: "https://github.com/praxis-built/shop" });
      }) as never,
    });
    expect(await o.ensureRepo("shop")).toEqual({ full_name: "praxis-built/shop", default_branch: "trunk", repo_url: "https://github.com/praxis-built/shop" });
    expect(waits).toEqual([200, 400]);
  });
});
