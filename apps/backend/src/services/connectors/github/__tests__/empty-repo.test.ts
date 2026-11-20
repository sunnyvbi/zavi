import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

vi.mock("@/services/connectors/github/scoped-repos", () => ({
  getScopedRepoFullNames: async () => ["acme/empty", "acme/web"],
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: { installation_id: 7, repo_ids: [], repo_full_names: [] }, error: null }),
      };
      return b;
    },
  }),
}));
import { listInstallationRepos, repoIsEmpty, _resetTokenCacheForTests } from "../oauth";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

type Route = (url: string) => Response | Promise<Response>;
function stubFetch(route: Route) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/access_tokens")) {
        return new Response(
          JSON.stringify({ token: "t", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
          { status: 201 },
        );
      }
      return route(url);
    }),
  );
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  _resetTokenCacheForTests();
  vi.stubEnv("GITHUB_APP_ID", "1");
  vi.stubEnv("GITHUB_APP_SLUG", "zavi");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("listInstallationRepos", () => {
  it("lists repos with content before empty ones, keeping GitHub's order within each", async () => {
    stubFetch(() =>
      json({
        total_count: 4,
        repositories: [
          { id: 1, name: "empty", full_name: "acme/empty", private: false, size: 0 },
          { id: 2, name: "web", full_name: "acme/web", private: true, size: 120 },
          { id: 3, name: "blank", full_name: "acme/blank", private: false, size: 0 },
          { id: 4, name: "api", full_name: "acme/api", private: true, size: 9 },
        ],
      }),
    );
    const repos = await listInstallationRepos({ tenant_id: "t1", installation_id: 7 });
    expect(repos.map((r) => r.full_name)).toEqual(["acme/web", "acme/api", "acme/empty", "acme/blank"]);
    expect(repos[0]).toEqual({ id: 2, name: "web", full_name: "acme/web", private: true });
  });
});

describe("repoIsEmpty", () => {
  const args = { tenant_id: "t1", repo_full_name: "acme/empty" };

  it("no branches → empty", async () => {
    stubFetch(() => json([]));
    expect(await repoIsEmpty(args)).toBe(true);
  });

  it("GitHub's 409 for an empty repo → empty", async () => {
    stubFetch(() => json({ message: "Git Repository is empty." }, 409));
    expect(await repoIsEmpty(args)).toBe(true);
  });

  it("has a branch, on any name → not empty", async () => {
    stubFetch(() => json([{ name: "development" }]));
    expect(await repoIsEmpty(args)).toBe(false);
  });

  it("a stalled token mint gives up after 5s and counts as not empty", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
      const result = repoIsEmpty(args);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await result).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a GitHub failure is not evidence of an empty repo", async () => {
    stubFetch(() => json({ message: "boom" }, 502));
    expect(await repoIsEmpty(args)).toBe(false);
    stubFetch(() => {
      throw new Error("network");
    });
    expect(await repoIsEmpty(args)).toBe(false);
  });
});
