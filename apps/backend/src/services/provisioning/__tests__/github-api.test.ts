import { describe, it, expect } from "vitest";
import {
  gitHubPathTemplate,
  gitHubRetryDelayMs,
  isGitHubRateLimit,
  readGitHubFailure,
  withGitHubRetry,
  type GitHubAttemptFailure,
  type GitHubFailure,
  type GitHubFetch,
  type GitHubResponse,
} from "../github-api";
import { createGitHubRepoProvisioner } from "../github-repo";

function res(status: number, body: unknown, hdrs: Record<string, string> = {}): GitHubResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, headers: { get: (n: string) => hdrs[n.toLowerCase()] ?? null }, json: async () => JSON.parse(text) as unknown, text: async () => text };
}

const base: GitHubFailure = {
  status: 500, message: null, errors: [], documentation_url: null, request_id: null, date: null,
  ratelimit_remaining: null, ratelimit_reset: null, ratelimit_resource: null, retry_after_s: null,
  accepted_permissions: null, oauth_scopes: null, token_expiration: null, sso_required: false,
};

describe("github api failures", () => {
  it("masks owner, repo, org and branch in the logged path", () => {
    expect(gitHubPathTemplate("https://api.github.com/repos/praxis-built/bakery-1a2b/git/refs/heads/main")).toBe("/repos/:owner/:repo/git/refs/heads/:branch");
    expect(gitHubPathTemplate("https://api.github.com/orgs/praxis-built/repos")).toBe("/orgs/:org/repos");
    expect(gitHubPathTemplate("https://api.github.com/repos/praxis-built/x/git/trees?recursive=1")).toBe("/repos/:owner/:repo/git/trees");
  });

  it("an exhausted primary limit waits until reset when that is within the cap, else not at all", () => {
    const nowMs = () => 1_000_000_000_000;
    const f = { ...base, status: 403, ratelimit_remaining: 0, ratelimit_reset: 1_000_000_004 };
    expect(isGitHubRateLimit(f)).toBe(true);
    expect(gitHubRetryDelayMs(f, 1, { nowMs })).toBe(5_000);
    expect(gitHubRetryDelayMs({ ...f, ratelimit_reset: 1_000_003_600 }, 1, { nowMs })).toBeNull();
    expect(gitHubRetryDelayMs({ ...base, status: 403, message: "You have exceeded a secondary rate limit" }, 1)).toBeNull();
    expect(gitHubRetryDelayMs({ ...base, status: 404 }, 1)).toBeNull();
  });

  it("a body that hangs after the headers arrive is cut off by the attempt timeout (an error body is retried)", async () => {
    const failures: GitHubAttemptFailure[] = [];
    let calls = 0;
    const hangs = (status: number): GitHubFetch => async (_url, init) => {
      calls++;
      const pending = () =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
      return { status, json: pending, text: pending };
    };
    const opts = { attemptTimeoutMs: 10, attempts: 2, sleep: async () => undefined, onFailure: (x: GitHubAttemptFailure) => failures.push(x) };

    await expect(withGitHubRetry(hangs(500), opts)("https://api.github.com/repos/o/r")).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(2);
    expect(failures.map((x) => [x.network_error, x.will_retry])).toEqual([["AbortError", true], ["AbortError", false]]);

    calls = 0;
    const ok = await withGitHubRetry(hangs(200), opts)("https://api.github.com/repos/o/r");
    await expect(ok.json()).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("no attempt starts once the caller's budget is spent, and a cancelled caller is not retried", async () => {
    let calls = 0;
    const fetchFn: GitHubFetch = async () => {
      calls++;
      return res(503, { message: "Service Unavailable" });
    };
    const spent = withGitHubRetry(fetchFn, { deadline: () => 1_000, nowMs: () => 2_000, sleep: async () => undefined });
    await expect(spent("https://api.github.com/repos/o/r")).rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls).toBe(0);

    const controller = new AbortController();
    controller.abort();
    await expect(withGitHubRetry(fetchFn)("https://api.github.com/repos/o/r", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
  });

  it("a gateway HTML body keeps only its first line", async () => {
    const f = await readGitHubFailure(res(504, "\n<html><body>Gateway Timeout</body></html>\nmore"));
    expect(f.message).toBe("<html><body>Gateway Timeout</body></html>");
  });

  it("the legacy provisioner throws GitHub's words, not the raw body, and rebinds a create that landed", async () => {
    let posted = 0;
    const logged: GitHubAttemptFailure[] = [];
    const p = createGitHubRepoProvisioner({
      token: () => "tok",
      org: () => "praxis-built",
      sleep: async () => undefined,
      logFailure: (f) => logged.push(f),
      fetchFn: async (_url, init) => {
        if (init?.method === "POST") {
          posted++;
          return res(500, { message: "Repository creation failed.", huge: "x".repeat(5000) }, { "x-github-request-id": "L:1" });
        }
        return posted > 0 ? res(200, { full_name: "praxis-built/photo-studio-abcd1234", default_branch: "main" }) : res(404, { message: "Not Found" });
      },
    });
    const r = await p.ensure({ tenant_id: "abcd1234-0000-4000-8000-000000000000", company_name: "Photo Studio" });
    expect(r.external_ref.github_full_name).toBe("praxis-built/photo-studio-abcd1234");
    expect(posted).toBe(1);
    expect(logged.map((f) => [f.method, f.recovered])).toEqual([["POST", true]]);

    const failing = createGitHubRepoProvisioner({
      token: () => "tok",
      org: () => "praxis-built",
      sleep: async () => undefined,
      logFailure: () => undefined,
      fetchFn: async (_url, init) => (init?.method === "POST" ? res(500, { message: "Repository creation failed.", huge: "x".repeat(5000) }, { "x-github-request-id": "L:1" }) : res(404, {})),
    });
    const err = (await failing.ensure({ tenant_id: "abcd1234-0000-4000-8000-000000000000", company_name: "Photo Studio" }).catch((e: Error) => e)) as Error;
    expect(err.message).toBe('github repo create failed (500): GitHub said "Repository creation failed."; request L:1');
  });
});
