
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClientMock: vi.fn(),
  getScopedReposMock: vi.fn(),
}));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/connectors/github/oauth", () => ({
  mintInstallationToken: vi.fn(async () => "ghs_fake"),
  ghInstallationHeaders: vi.fn(() => ({ authorization: "Bearer ghs_fake" })),
}));
vi.mock("@/services/connectors/github/scoped-repos", () => ({
  getScopedRepos: mocks.getScopedReposMock,
}));

import { callGithubTool } from "../github";

const ctx = { tenant_id: "t1", run_id: "r1", agent_slug: "operator" } as Parameters<typeof callGithubTool>[0];
const COORD = { owner: "acme", repo: "app" };

const RESET_IN_SECONDS = 600;
function limited(): Response {
  return new Response(JSON.stringify({ message: "API rate limit exceeded for installation ID 42." }), {
    status: 403,
    headers: {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + RESET_IN_SECONDS),
    },
  });
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function installGithub(shaPrefix: string, files: Record<string, string>, opts?: { limitAfterReads?: number }) {
  let reads = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/git/trees/")) {
      return json({
        tree: Object.entries(files).map(([path, body]) => ({
          path,
          type: "blob",
          size: body.length,
          sha: `${shaPrefix}-${path}`,
        })),
      });
    }
    if (opts?.limitAfterReads !== undefined && reads >= opts.limitAfterReads) return limited();
    reads++;
    const path = decodeURIComponent(/\/contents\/([^?]+)/.exec(url)![1]);
    return json({ type: "file", encoding: "base64", content: Buffer.from(files[path]).toString("base64") });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const contentCalls = (fetchMock: ReturnType<typeof installGithub>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes("/contents/")).length;

const manyFiles = (n: number) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/f${i}.ts`, i === 0 ? "needle" : "x"]));

beforeEach(() => {
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { installation_id: 42 }, error: null }) }) }),
      }),
    }),
  });
  mocks.getScopedReposMock.mockResolvedValue({
    repos: ["acme/app"],
    scoped: false,
    allConnected: ["acme/app"],
    selectionRequired: false,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a GitHub rate limit reaches the tool call with its real reason", () => {
  it("read_file says rate limited, quotes GitHub, gives the wait, and rules out reading it as absence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => limited()));
    const res = await callGithubTool(ctx, "read_file", { ...COORD, path: "src/a.ts" });
    expect(res.is_error).toBe(true);
    const body = JSON.parse(res.content);
    expect(body.error).toBe("github_rate_limited");
    expect(body.message).toContain("API rate limit exceeded");
    expect(body.message).toContain("HTTP 403");
    expect(body.meta.retry_after_seconds).toBeGreaterThan(RESET_IN_SECONDS - 5);
    expect(body.message).toMatch(/NOT read/);
  });

  it("grep reports the rate limit when the tree call itself is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => limited()));
    const res = await callGithubTool(ctx, "grep", { ...COORD, pattern: "needle" });
    expect(JSON.parse(res.content).error).toBe("github_rate_limited");
  });

  it("a plain permission 403 is not called a rate limit and is not retried", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(callGithubTool(ctx, "read_file", { ...COORD, path: "src/a.ts" })).rejects.toThrow(
      "read_file HTTP 403: Resource not accessible by integration",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("grep spends less of the allowance", () => {
  it("a second scan of the same files makes no file reads", async () => {
    const fetchMock = installGithub("repeat", manyFiles(20));
    await callGithubTool(ctx, "grep", { ...COORD, pattern: "needle" });
    expect(contentCalls(fetchMock)).toBe(20);
    const again = JSON.parse((await callGithubTool(ctx, "grep", { ...COORD, pattern: "x" })).content);
    expect(contentCalls(fetchMock)).toBe(20);
    expect(again.scanned_files).toBe(20);
    expect(again.matches.length).toBeGreaterThan(0);
  });

  it("does not serve one repo's cached file to another repo with the same blob", async () => {
    mocks.getScopedReposMock.mockResolvedValue({
      repos: ["acme/app", "acme/other"],
      scoped: false,
      allConnected: ["acme/app", "acme/other"],
      selectionRequired: false,
    });
    const fetchMock = installGithub("isolated", { "src/a.ts": "needle" });
    await callGithubTool(ctx, "grep", { ...COORD, pattern: "needle" });
    await callGithubTool(ctx, "grep", { owner: "acme", repo: "other", pattern: "needle" });
    expect(contentCalls(fetchMock)).toBe(2);
  });

  it("stops scanning at a rate limit, keeps what it found, and never claims a complete scan", async () => {
    const fetchMock = installGithub("midscan", manyFiles(100), { limitAfterReads: 10 });
    const res = await callGithubTool(ctx, "grep", { ...COORD, pattern: "needle" });
    const body = JSON.parse(res.content);
    expect(res.is_error).toBe(false);
    expect(body.complete).toBe(false);
    expect(body.hint).toContain("rate limit");
    expect(body.next_cursor).toBeTruthy();
    expect(body.next_cursor).toMatch(/\.10$/);
    expect(contentCalls(fetchMock)).toBeLessThanOrEqual(10 + 8 * 3);
  });
});

describe("repo passed as owner/name", () => {
  it.each([
    ["without owner", { repo: "acme/app" }],
    ["with a matching owner", { owner: "acme", repo: "acme/app" }],
  ])("is split %s", async (_label, coord) => {
    installGithub("split", { "src/a.ts": "needle" });
    const res = await callGithubTool(ctx, "grep", { ...coord, pattern: "needle" });
    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content).matches).toHaveLength(1);
  });

  it("cannot reach a repo the tenant has not connected", async () => {
    const res = await callGithubTool(ctx, "grep", { repo: "victim/secrets", pattern: "needle" });
    expect(JSON.parse(res.content).error).toBe("repo_not_authorized");
  });

  it("is left alone when the prefix contradicts owner", async () => {
    const res = await callGithubTool(ctx, "grep", { owner: "acme", repo: "victim/secrets", pattern: "needle" });
    expect(res.is_error).toBe(true);
  });
});
