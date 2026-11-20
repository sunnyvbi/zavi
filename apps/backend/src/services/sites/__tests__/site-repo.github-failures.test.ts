
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSiteRepoOps,
  __resetSiteRepoCreateStreakForTests,
  SITE_REPO_CREATE_ALERT_AFTER,
  SITE_REPO_CREATE_ALERT_CODE,
} from "../site-repo";
import { isTransientPlatformError } from "../platform-errors";
import type { GitHubAttemptFailure, GitHubResponse } from "@/services/provisioning/github-api";
import { gitHubFailureLogInput } from "@/services/provisioning/github-api";
import type { AlertInput } from "@/services/logging/alert";

type Init = { method?: string; headers?: Record<string, string>; body?: string };

function res(status: number, body: unknown = {}, hdrs: Record<string, string> = {}): GitHubResponse {
  const lower = Object.fromEntries(Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), v]));
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  };
}

const TOKEN = "ghp_SECRETTOKEN123456";

function harness(
  handler: (url: string, init: Init | undefined, n: number) => GitHubResponse | Promise<GitHubResponse>,
  opts: { fetchMs?: number } = {},
) {
  const calls: Array<{ method: string; url: string }> = [];
  const failures: GitHubAttemptFailure[] = [];
  const waits: number[] = [];
  const alerts: AlertInput[] = [];
  let n = 0;
  let clock = Date.UTC(2026, 9, 7, 12, 0, 0);
  const ops = createSiteRepoOps({
    token: () => TOKEN,
    org: () => "praxis-built",
    now: () => clock,
    fetchFn: async (url, init) => {
      calls.push({ method: init?.method ?? "GET", url });
      clock += opts.fetchMs ?? 0;
      return handler(url, init, n++);
    },
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    logFailure: (f) => failures.push(f),
    alert: async (a) => {
      alerts.push(a);
    },
  });
  return { ops, calls, failures, waits, alerts };
}

const posts = (calls: Array<{ method: string }>) => calls.filter((c) => c.method === "POST").length;

beforeEach(() => __resetSiteRepoCreateStreakForTests());

describe("site repo creation on a GitHub failure", () => {
  it("a 500 on every create attempt retries with backoff, then throws GitHub's diagnosis (no token) as a transient platform error", async () => {
    const h = harness((_url, init) =>
      init?.method === "POST"
        ? res(500, { message: "Repository creation failed.", documentation_url: "https://docs.github.com/rest/repos/repos#create-an-organization-repository" }, { "x-github-request-id": "C0FE:1234:ABCD", "x-ratelimit-remaining": "4990" })
        : res(404, { message: "Not Found" }),
    );
    const err = await h.ops.ensureRepo("bakery-orders-1a2b").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/^site repo create failed \(500\)/);
    expect(message).toContain('GitHub said "Repository creation failed."');
    expect(message).toContain("request C0FE:1234:ABCD");
    expect(message).not.toContain(TOKEN);
    expect(isTransientPlatformError(err)).toBe(true);

    expect(posts(h.calls)).toBe(3);
    expect(h.waits).toHaveLength(2);
    expect(h.waits[0]).toBeGreaterThanOrEqual(1000);
    expect(h.waits[1]).toBeGreaterThanOrEqual(2000);

    const createFailures = h.failures.filter((f) => f.method === "POST");
    expect(createFailures.map((f) => [f.attempt, f.will_retry])).toEqual([[0, true], [1, true], [2, false]]);
    const row = gitHubFailureLogInput("site-repo", createFailures[2]!);
    expect(row).toMatchObject({
      level: "error",
      source: "site-repo",
      code: "github_repo_create_failed",
      meta: { http_status: 500, github_request_id: "C0FE:1234:ABCD", ratelimit_remaining: 4990, retry_count: 2, stage: "create", path: "/orgs/:org/repos" },
    });
    expect(row.message).toContain("Repository creation failed.");
    expect(row.message).toContain("docs docs.github.com/rest/repos/repos#create-an-organization-repository");
    expect(JSON.stringify(row)).not.toContain(TOKEN);
  });

  it("a 500 that clears on the next attempt returns the repo, with nothing paged", async () => {
    let posted = 0;
    let created = false;
    const h = harness((_url, init) => {
      if (init?.method === "POST") {
        posted++;
        if (posted === 1) return res(502, "<html>\nBad Gateway</html>");
        created = true;
        return res(201, { full_name: "praxis-built/dentist-booking-9f8e" });
      }
      return created ? res(200, { full_name: "praxis-built/dentist-booking-9f8e", default_branch: "main", html_url: "https://github.com/praxis-built/dentist-booking-9f8e" }) : res(404);
    });
    const ref = await h.ops.ensureRepo("dentist-booking-9f8e");
    expect(ref.full_name).toBe("praxis-built/dentist-booking-9f8e");
    expect(posted).toBe(2);
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]!.failure?.status).toBe(502);
    expect(h.failures[0]!.failure?.message).toBe("<html>");
    expect(h.alerts).toHaveLength(0);
  });

  it("a create that landed despite a 500 rebinds by the re-read, without a second POST", async () => {
    let posted = 0;
    const h = harness((_url, init) => {
      if (init?.method === "POST") {
        posted++;
        return res(500, { message: "Server Error" }, { "x-github-request-id": "REC:1" });
      }
      return posted === 0 ? res(404) : res(200, { full_name: "praxis-built/photo-portfolio-77aa", default_branch: "main" });
    });
    expect((await h.ops.ensureRepo("photo-portfolio-77aa")).full_name).toBe("praxis-built/photo-portfolio-77aa");
    expect(posted).toBe(1);
    expect(h.waits).toEqual([]);
    expect(h.alerts).toHaveLength(0);
    expect(h.failures).toHaveLength(1);
    const row = gitHubFailureLogInput("site-repo", h.failures[0]!);
    expect(row).toMatchObject({ level: "warn", code: "github_repo_create_failed", meta: { http_status: 500, github_request_id: "REC:1" } });
    expect(row.message).toContain("recovered");
  });

  it("an ambiguous create whose re-read also fails is never POSTed again", async () => {
    const h = harness((_url, init) => {
      if (init?.method === "POST") return res(500, { message: "Server Error" });
      return h.calls.some((c) => c.method === "POST") ? res(503, { message: "Service Unavailable" }) : res(404);
    });
    const err = (await h.ops.ensureRepo("bakery-orders-1a2b").catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/^site repo create failed \(500\)/);
    expect(posts(h.calls)).toBe(1);
  });

  it("a bare 429 is a rate limit: retryable, never a configuration page", async () => {
    const h = harness((_url, init) => (init?.method === "POST" ? res(429, "") : res(404)));
    const err = (await h.ops.ensureRepo("shop-123").catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/failed \(429\).*rate limited/);
    await Promise.resolve();
    expect(h.alerts).toHaveLength(0);
  });

  it("a concurrent create (422 name-exists) rebinds to the repo that won", async () => {
    let posted = 0;
    const h = harness((_url, init) => {
      if (init?.method === "POST") {
        posted++;
        return res(422, { message: "Repository creation failed.", errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }] });
      }
      return posted === 0 ? res(404) : res(200, { full_name: "praxis-built/photo-portfolio-77aa", default_branch: "main" });
    });
    expect((await h.ops.ensureRepo("photo-portfolio-77aa")).full_name).toBe("praxis-built/photo-portfolio-77aa");
    expect(posted).toBe(1);
    expect(h.failures.map((f) => gitHubFailureLogInput("site-repo", f).level)).toEqual(["warn"]);
  });

  it("a 422 that is not a race is the request's fault: not retried, errors[] reach the log, ops paged at once", async () => {
    const h = harness((_url, init) =>
      init?.method === "POST"
        ? res(422, { message: "Repository creation failed.", errors: [{ resource: "Repository", code: "custom", field: "name", message: "name is too long" }] }, { "x-github-request-id": "AB:CD" })
        : res(404),
    );
    const err = (await h.ops.ensureRepo("shop-123").catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/^site repo create failed \(422\): GitHub said "Repository creation failed."; request AB:CD$/);
    expect(isTransientPlatformError(err)).toBe(false);
    expect(posts(h.calls)).toBe(1);
    expect(h.waits).toEqual([]);
    const row = gitHubFailureLogInput("site-repo", h.failures.find((f) => f.method === "POST")!);
    expect(row.level).toBe("error");
    expect(row.message).toContain("errors: Repository.name custom: name is too long");
    await vi.waitFor(() => expect(h.alerts).toHaveLength(1));
    expect(h.alerts[0]!.msg).toContain("failed on configuration");
  });

  it("a 403 that is not a rate limit (bad scope) is not retried; the token headers reach the log, not last_error", async () => {
    const h = harness((_url, init) =>
      init?.method === "POST"
        ? res(403, { message: "Resource not accessible by personal access token" }, {
            "x-accepted-github-permissions": "administration=write",
            "github-authentication-token-expiration": "2026-10-01 00:00:00 UTC",
            "x-github-sso": "required; url=https://github.com/orgs/praxis-built/sso?authorization_request=SECRETSSO",
          })
        : res(404),
    );
    const err = (await h.ops.ensureRepo("shop-123").catch((e: Error) => e)) as Error;
    expect(err.message).toContain("Resource not accessible by personal access token");
    expect(err.message).not.toContain("administration");
    expect(posts(h.calls)).toBe(1);
    const row = gitHubFailureLogInput("site-repo", h.failures.find((f) => f.method === "POST")!);
    expect(row.message).toContain("endpoint needs administration=write");
    expect(row.message).toContain("token expires 2026-10-01 00:00:00 UTC");
    expect(row.message).toContain("org requires SSO authorization");
    expect(JSON.stringify(row)).not.toContain("SECRETSSO");
  });

  it("no retry wait starts past the call's budget (setup runs inside the founder's request)", async () => {
    const h = harness(() => res(503, { message: "Service Unavailable" }), { fetchMs: 14_000 });
    const err = (await h.ops.ensureRepo("shop-123").catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/^site repo lookup failed \(503\)/);
    expect(h.calls).toHaveLength(2);
    expect(h.failures.map((f) => f.will_retry)).toEqual([true, false]);
  });

  it("a 403 secondary rate limit waits out Retry-After and then succeeds", async () => {
    let posted = 0;
    let created = false;
    const h = harness((_url, init) => {
      if (init?.method === "POST") {
        posted++;
        if (posted === 1) return res(403, { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." }, { "retry-after": "7" });
        created = true;
        return res(201, {});
      }
      return created ? res(200, { full_name: "praxis-built/shop-123", default_branch: "main" }) : res(404);
    });
    expect((await h.ops.ensureRepo("shop-123")).full_name).toBe("praxis-built/shop-123");
    expect(h.waits[0]).toBe(7000);
    expect(h.failures[0]!.failure?.retry_after_s).toBe(7);
    expect(gitHubFailureLogInput("site-repo", h.failures[0]!).meta).toMatchObject({ retry_after_s: 7, http_status: 403 });
  });

  it("a secondary rate limit whose Retry-After is past the cap fails at once (retryable) instead of hanging the setup", async () => {
    const h = harness((_url, init) =>
      init?.method === "POST" ? res(429, { message: "secondary rate limit" }, { "retry-after": "600" }) : res(404),
    );
    const err = (await h.ops.ensureRepo("shop-123").catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/failed \(429\).*rate limited.*retry after 600s/);
    expect(posts(h.calls)).toBe(1);
    expect(h.waits).toEqual([]);
  });

  it("a 5xx on the lookup is retried and, when it persists, says it was the lookup", async () => {
    const h = harness(() => res(503, { message: "Service Unavailable" }, { "x-github-request-id": "R1" }));
    const err = (await h.ops.ensureRepo("shop-123").catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/^site repo lookup failed \(503\)/);
    expect(posts(h.calls)).toBe(0);
    expect(h.failures.map((f) => gitHubFailureLogInput("site-repo", f).code)).toEqual(["github_repo_read_failed", "github_repo_read_failed", "github_repo_read_failed"]);
  });

  it("pages ops once when creation fails N times in a row, and a success resets the streak", async () => {
    let fail = true;
    let created = false;
    const h = harness((_url, init) => {
      if (init?.method === "POST") {
        if (fail) return res(500, { message: "Repository creation failed." });
        created = true;
        return res(201, {});
      }
      return created ? res(200, { full_name: "praxis-built/shop-1", default_branch: "main" }) : res(404);
    });
    for (let i = 0; i < SITE_REPO_CREATE_ALERT_AFTER - 1; i++) await h.ops.ensureRepo(`shop-${i}`).catch(() => undefined);
    await Promise.resolve();
    expect(h.alerts).toHaveLength(0);
    await h.ops.ensureRepo("shop-x").catch(() => undefined);
    await vi.waitFor(() => expect(h.alerts).toHaveLength(1));
    expect(h.alerts[0]).toMatchObject({ source: "site-repo", code: SITE_REPO_CREATE_ALERT_CODE });
    expect(h.alerts[0]!.msg).toContain(`failed ${SITE_REPO_CREATE_ALERT_AFTER} times in a row`);
    expect(h.alerts[0]!.msg).toContain("GitHub answered 500");
    expect(h.alerts[0]!.msg).not.toContain("shop-x");
    expect(h.alerts[0]!.msg).not.toContain(TOKEN);
    expect(h.alerts[0]!.email?.dedupeKey).toMatch(/^site-repo:github_repo_create_failing:/);
    expect(h.alerts[0]!.email?.subjectDetail).toBe("website builds down: GitHub repo creation failing");
    await h.ops.ensureRepo("shop-y").catch(() => undefined);
    await Promise.resolve();
    expect(h.alerts).toHaveLength(1);

    fail = false;
    await h.ops.ensureRepo("shop-1");
    fail = true;
    created = false;
    for (let i = 0; i < SITE_REPO_CREATE_ALERT_AFTER - 1; i++) await h.ops.ensureRepo(`shop-z${i}`).catch(() => undefined);
    await Promise.resolve();
    expect(h.alerts).toHaveLength(1);
  });

  it("a network error is retried, then surfaces as a transient failure", async () => {
    const h = harness(() => {
      throw new TypeError("fetch failed");
    });
    const err = await h.ops.ensureRepo("shop-123").catch((e: Error) => e);
    expect(isTransientPlatformError(err)).toBe(true);
    expect(h.calls).toHaveLength(3);
    const row = gitHubFailureLogInput("site-repo", h.failures[2]!);
    expect(row).toMatchObject({ level: "error", meta: { error_class: "TypeError" } });
    expect(row.message).toContain("answered network");
  });
});

describe("site repo seed on a GitHub failure", () => {
  it("retries a 5xx on a seed call and throws GitHub's words, not the raw body", async () => {
    let blobs = 0;
    const h = harness((url, init) => {
      if (url.endsWith("/git/trees") && init?.method === "POST") return res(500, { message: "Internal Server Error" }, { "x-github-request-id": "SEED:1" });
      if (url.endsWith("/git/blobs")) {
        blobs++;
        return res(201, { sha: "b1" });
      }
      if (url.includes("/git/trees/")) return res(200, { tree: [{ path: "README.md", type: "blob" }] });
      if (url.includes("/git/commits/")) return res(200, { tree: { sha: "tree_base" } });
      if (url.includes("/git/ref/heads/")) return res(200, { object: { sha: "commit_base" } });
      return res(200, { default_branch: "main" });
    });
    const err = (await h.ops.seed("t1", "praxis-built/bakery-orders-1a2b", { "index.html": "<h1>hi</h1>" }, { default_branch: "main" }).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/seedTemplate tree failed \(500\): GitHub said "Internal Server Error"; request SEED:1/);
    expect(h.calls.filter((c) => c.method === "POST" && c.url.endsWith("/git/trees"))).toHaveLength(3);
    expect(gitHubFailureLogInput("site-repo", h.failures[0]!).code).toBe("github_repo_seed_failed");
    expect(blobs).toBe(0);
  });

  it("a branch update that landed although GitHub answered 5xx counts as seeded", async () => {
    let head = "commit_base";
    let patches = 0;
    const h = harness((url, init) => {
      if (init?.method === "PATCH") {
        patches++;
        head = "c_new";
        return res(502, { message: "Bad Gateway" });
      }
      if (url.endsWith("/git/trees") && init?.method === "POST") return res(201, { sha: "tree_new" });
      if (url.endsWith("/git/commits") && init?.method === "POST") return res(201, { sha: "c_new" });
      if (url.includes("/git/trees/")) return res(200, { tree: [{ path: "README.md", type: "blob" }] });
      if (url.includes("/git/commits/")) return res(200, { tree: { sha: "tree_base" } });
      if (url.includes("/git/ref/heads/")) return res(200, { object: { sha: head } });
      return res(200, { default_branch: "main" });
    });
    expect(await h.ops.seed("t1", "praxis-built/dentist-booking-9f8e", { "index.html": "<h1>hi</h1>" }, { default_branch: "main" })).toBe("c_new");
    expect(patches).toBe(3);
  });
});
