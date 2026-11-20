
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PLATFORM_SOURCE_REPO, SELF_HEAL_SOURCE_AGENT } from "@/services/self-heal-credential";

const STAFF = "staff-tenant-xyz";
const [PLAT_OWNER, PLAT_REPO] = PLATFORM_SOURCE_REPO.split("/");

const mocks = vi.hoisted(() => ({
  mintInstallationToken: vi.fn(async () => "ghs_installtoken"),
  ghInstallationHeaders: vi.fn((tok: string) => ({ authorization: `Bearer ${tok}` })),
  serviceClientMock: vi.fn(),
}));
vi.mock("@/services/connectors/github/oauth", () => ({
  mintInstallationToken: mocks.mintInstallationToken,
  ghInstallationHeaders: mocks.ghInstallationHeaders,
}));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));

import { callGithubTool } from "../github";

function installDb(opts: { selfHealRun: boolean; connectorInstall: number | null }) {
  mocks.serviceClientMock.mockReset();
  mocks.serviceClientMock.mockImplementation(() => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === "agent_runs"
              ? {
                  data: opts.selfHealRun
                    ? { tenant_id: STAFF, agent_slug: "engineer", payload: { source_agent: SELF_HEAL_SOURCE_AGENT } }
                    : { tenant_id: STAFF, agent_slug: "engineer", payload: { source_agent: "pm" } },
                  error: null,
                }
              : {
                  data: opts.connectorInstall === null ? null : { installation_id: opts.connectorInstall, account_login: "acme" },
                  error: null,
                },
          eq: () => ({
            maybeSingle: async () => ({
              data: opts.connectorInstall === null ? null : { installation_id: opts.connectorInstall, account_login: "acme" },
              error: null,
            }),
          }),
        }),
      }),
    }),
  }));
}

function installFetchCapture(): { auths: string[] } {
  const auths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (h.authorization) auths.push(h.authorization);
      return {
        ok: true,
        status: 200,
        json: async () => ({ object: { sha: "s" }, sha: "s", number: 1, html_url: "u" }),
        text: async () => "{}",
      } as unknown as Response;
    }),
  );
  return { auths };
}

const ctx = { tenant_id: STAFF, run_id: "run-1" } as const;

function reset() {
  delete process.env.SELF_HEAL_ENABLED;
  delete process.env.SELF_HEAL_STAFF_TENANT_ID;
  delete process.env.GITHUB_PROVISION_TOKEN;
  vi.unstubAllGlobals();
}
beforeEach(reset);
afterEach(reset);

describe("self-heal write-credential seam", () => {
  it("flag-ON staff self-heal engineer run → open_pr(praxis) uses the umbrella PAT", async () => {
    process.env.SELF_HEAL_ENABLED = "1";
    process.env.SELF_HEAL_STAFF_TENANT_ID = STAFF;
    process.env.GITHUB_PROVISION_TOKEN = "ghp_umbrella_secret";
    installDb({ selfHealRun: true, connectorInstall: null });
    const { auths } = installFetchCapture();

    try {
      await callGithubTool(ctx, "open_pr", {
        owner: PLAT_OWNER,
        repo: PLAT_REPO,
        base_branch: "main",
        head_branch: "self-heal/fix",
        title: "self-heal fix",
        body: "x",
        files: [{ path: "a.ts", action: "create", content: "export const a = 1;" }],
      });
    } catch {
    }

    expect(auths.length).toBeGreaterThan(0);
    expect(auths.every((a) => a.includes("ghp_umbrella_secret"))).toBe(true);
    expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
  });

  it("agent_runs read ERROR → denied (fail-closed, not granted)", async () => {
    process.env.SELF_HEAL_ENABLED = "1";
    process.env.SELF_HEAL_STAFF_TENANT_ID = STAFF;
    process.env.GITHUB_PROVISION_TOKEN = "ghp_umbrella_secret";
    mocks.serviceClientMock.mockReset();
    mocks.serviceClientMock.mockImplementation(() => ({
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () =>
              table === "agent_runs"
                ? { data: null, error: { message: "boom" } }
                : { data: null, error: null },
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          }),
        }),
      }),
    }));
    installFetchCapture();
    const res = await callGithubTool(ctx, "open_pr", {
      owner: PLAT_OWNER,
      repo: PLAT_REPO,
      base_branch: "main",
      head_branch: "self-heal/fix",
      title: "x",
      body: "x",
      files: [{ path: "a.ts", action: "create", content: "export const a = 1;" }],
    });
    expect(res.is_error).toBe(true);
    expect(JSON.stringify(res.content)).toContain("github_not_connected");
  });

  it("flag-OFF → open_pr(praxis) denied (falls to tenant resolution, no App install)", async () => {
    installDb({ selfHealRun: true, connectorInstall: null });
    installFetchCapture();
    const res = await callGithubTool(ctx, "open_pr", {
      owner: PLAT_OWNER,
      repo: PLAT_REPO,
      base_branch: "main",
      head_branch: "self-heal/fix",
      title: "x",
      body: "x",
      files: [{ path: "a.ts", action: "create", content: "export const a = 1;" }],
    });
    expect(res.is_error).toBe(true);
    expect(JSON.stringify(res.content)).toContain("github_not_connected");
  });
});
