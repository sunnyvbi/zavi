
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PLATFORM_SOURCE_REPO, isPlatformSourceRepo } from "@/services/platform-source-repo";

const mocks = vi.hoisted(() => ({
  mintInstallationToken: vi.fn(async () => "ghs_faketoken"),
  ghInstallationHeaders: vi.fn(() => ({ authorization: "Bearer ghs_faketoken" })),
  serviceClientMock: vi.fn(),
}));

vi.mock("@/services/connectors/github/oauth", () => ({
  mintInstallationToken: mocks.mintInstallationToken,
  ghInstallationHeaders: mocks.ghInstallationHeaders,
}));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));

import { callGithubTool } from "../github";

const ctx = { tenant_id: "t-1", run_id: "r-1" } as const;
const [PLAT_OWNER, PLAT_REPO] = PLATFORM_SOURCE_REPO.split("/");

beforeEach(() => {
  vi.unstubAllGlobals();
  mocks.mintInstallationToken.mockClear();
  mocks.serviceClientMock.mockReset();
  mocks.serviceClientMock.mockImplementation(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { tenant_id: "other", agent_slug: "engineer", payload: {} }, error: null }),
          eq: () => ({ maybeSingle: async () => ({ data: { installation_id: 42 }, error: null }) }),
        }),
      }),
    }),
  }));
});

describe("isPlatformSourceRepo matcher", () => {
  it("matches the exact platform repo", () => {
    expect(isPlatformSourceRepo(PLAT_OWNER, PLAT_REPO)).toBe(true);
  });
  it("matches case-insensitively (casing trick cannot bypass)", () => {
    expect(isPlatformSourceRepo(PLAT_OWNER.toUpperCase(), PLAT_REPO.toUpperCase())).toBe(true);
    expect(isPlatformSourceRepo("Rravi149", "Praxis")).toBe(true);
  });
  it("normalizes surrounding whitespace, trailing slash, and .git suffix", () => {
    expect(isPlatformSourceRepo("rravi149 ", " praxis")).toBe(true);
    expect(isPlatformSourceRepo("rravi149", "praxis.git")).toBe(true);
    expect(isPlatformSourceRepo("rravi149", "praxis/")).toBe(true);
    expect(isPlatformSourceRepo("rravi149", "praxis.GIT")).toBe(true);
  });
  it("matches the repo's new name after the praxis -> zavi rename", () => {
    expect(isPlatformSourceRepo("rravi149", "zavi")).toBe(true);
    expect(isPlatformSourceRepo("RRAVI149", "Zavi.git")).toBe(true);
    expect(isPlatformSourceRepo("rravi149", "zavi-fork")).toBe(false);
    expect(isPlatformSourceRepo("someone-else", "zavi")).toBe(false);
  });
  it("does NOT match customer / provisioned repos", () => {
    expect(isPlatformSourceRepo("praxis-built", "acme")).toBe(false);
    expect(isPlatformSourceRepo("Praxis-build", "qab4")).toBe(false);
    expect(isPlatformSourceRepo("rravi149", "upcar")).toBe(false);
    expect(isPlatformSourceRepo("rravi149", "praxis-fork")).toBe(false);
    expect(isPlatformSourceRepo("notrravi149", "praxis")).toBe(false);
  });
});

describe("github write-tool guard — platform source repo is PR-not-merge", () => {
  function installFetchSpy(): { calls: number } {
    const tracker = { calls: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        tracker.calls += 1;
        return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" } as unknown as Response;
      }),
    );
    return tracker;
  }

  it("REFUSES push_to_main against the platform repo before any GitHub API call or token mint", async () => {
    const fetchTracker = installFetchSpy();
    const res = await callGithubTool(ctx, "push_to_main", {
      owner: PLAT_OWNER,
      repo: PLAT_REPO,
      base_branch: "main",
      title: "self-heal: fix the gate",
      files: [{ path: "x.ts", action: "create", content: "export const x = 1;" }],
    });
    expect(res.is_error).toBe(true);
    expect(JSON.stringify(res.content)).toContain("platform_source_repo_protected");
    expect(fetchTracker.calls).toBe(0);
    expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
  });

  it("REFUSES push_to_main even with a casing trick", async () => {
    const fetchTracker = installFetchSpy();
    const res = await callGithubTool(ctx, "push_to_main", {
      owner: PLAT_OWNER.toUpperCase(),
      repo: PLAT_REPO.toUpperCase(),
      base_branch: "main",
      title: "self-heal",
      files: [{ path: "x.ts", action: "create", content: "export const x = 1;" }],
    });
    expect(res.is_error).toBe(true);
    expect(JSON.stringify(res.content)).toContain("platform_source_repo_protected");
    expect(fetchTracker.calls).toBe(0);
  });

  it("REFUSES push_to_main against the repo's new name (rravi149/zavi)", async () => {
    const fetchTracker = installFetchSpy();
    const res = await callGithubTool(ctx, "push_to_main", {
      owner: "rravi149",
      repo: "zavi",
      base_branch: "main",
      title: "self-heal",
      files: [{ path: "x.ts", action: "create", content: "export const x = 1;" }],
    });
    expect(res.is_error).toBe(true);
    expect(JSON.stringify(res.content)).toContain("platform_source_repo_protected");
    expect(fetchTracker.calls).toBe(0);
    expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
  });

  it("REFUSES squash_merge against the platform repo before any network call", async () => {
    const fetchTracker = installFetchSpy();
    const res = await callGithubTool(ctx, "squash_merge", {
      owner: PLAT_OWNER,
      repo: PLAT_REPO,
      pull_number: 1,
      commit_title: "merge",
      commit_message: "self-heal merge",
    });
    expect(res.is_error).toBe(true);
    expect(JSON.stringify(res.content)).toContain("platform_source_repo_protected");
    expect(fetchTracker.calls).toBe(0);
  });

  it("ALLOWS push_to_main against a provisioned/customer repo (guard is platform-repo-only)", async () => {
    const fetchTracker = installFetchSpy();
    process.env.GITHUB_PROVISION_TOKEN = "ghp_test_umbrella_pat";
    try {
      await callGithubTool(ctx, "push_to_main", {
        owner: "praxis-built",
        repo: "acme",
        base_branch: "main",
        title: "build",
        files: [{ path: "x.ts", action: "create", content: "export const x = 1;" }],
      });
    } catch {
    }
    expect(fetchTracker.calls).toBeGreaterThan(0);
  });
});
