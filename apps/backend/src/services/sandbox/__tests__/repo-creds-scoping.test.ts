
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClientMock: vi.fn(),
  mintInstallationToken: vi.fn(async () => "ghs_minted"),
  assertProvisioned: vi.fn(
    async (): Promise<{
      ok: boolean;
      reason?: string;
      github_full_name?: string;
    }> => ({ ok: false, reason: "no row" }),
  ),
  resolveScopedRepos: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/connectors/github/oauth", () => ({
  mintInstallationToken: mocks.mintInstallationToken,
}));
vi.mock("@/services/provisioning/provisioned-repo-gate", () => ({
  assertProvisionedRepoTarget: mocks.assertProvisioned,
}));
vi.mock("@/services/connectors/github/scoped-repos", () => ({
  resolveScopedRepos: mocks.resolveScopedRepos,
}));

import { resolveRepoCredsForRun } from "../repo-creds";

function installConnectorMeta(meta: {
  installation_id?: number;
  repo_full_names?: string[];
  default_repo_full_name?: string | null;
}) {
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: meta, error: null }),
          }),
        }),
      }),
    }),
  });
}

function scoped(
  mode: "all" | "scoped" | "deny",
  repos: string[],
  allConnected: string[] = repos,
  selectionRequired = false,
) {
  return { mode, repos, allConnected, selectionRequired };
}

beforeEach(() => {
  mocks.serviceClientMock.mockReset();
  mocks.mintInstallationToken.mockClear();
  mocks.resolveScopedRepos.mockReset();
});

describe("resolveRepoCredsForRun scoping (P0-3 + fail-closed)", () => {
  it("REJECTS a repo_hint pointing at a scoped-OUT repo (no token minted)", async () => {
    installConnectorMeta({
      installation_id: 99,
      repo_full_names: ["acme/a", "acme/b"],
      default_repo_full_name: null,
    });
    mocks.resolveScopedRepos.mockResolvedValue(
      scoped("scoped", ["acme/a"], ["acme/a", "acme/b"]),
    );

    const result = await resolveRepoCredsForRun("t1", { repo_hint: "acme/b" });
    expect(result.kind).toBe("needs_pick");
    if (result.kind === "needs_pick") {
      expect(result.repos).toEqual(["acme/a"]);
    }
    expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
  });

  it("RESOLVES + mints for a repo_hint inside the scoped set", async () => {
    installConnectorMeta({
      installation_id: 99,
      repo_full_names: ["acme/a", "acme/b"],
      default_repo_full_name: null,
    });
    mocks.resolveScopedRepos.mockResolvedValue(
      scoped("scoped", ["acme/a"], ["acme/a", "acme/b"]),
    );

    const result = await resolveRepoCredsForRun("t1", { repo_hint: "acme/a" });
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.repo_full_name).toBe("acme/a");
      expect(result.provisioned).toBe(false);
    }
    expect(mocks.mintInstallationToken).toHaveBeenCalledWith(
      expect.objectContaining({ repo_full_name: "acme/a" }),
    );
  });

  it("auto-defaults to the single SCOPED repo (not the raw connected list)", async () => {
    installConnectorMeta({
      installation_id: 99,
      repo_full_names: ["acme/a", "acme/b"],
      default_repo_full_name: null,
    });
    mocks.resolveScopedRepos.mockResolvedValue(
      scoped("scoped", ["acme/a"], ["acme/a", "acme/b"]),
    );

    const result = await resolveRepoCredsForRun("t1", {});
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") expect(result.repo_full_name).toBe("acme/a");
  });

  it("FAILS CLOSED on resolver 'deny' — actionable error, NO needs_pick listing raw repos, NO token", async () => {
    installConnectorMeta({
      installation_id: 99,
      repo_full_names: ["acme/a", "acme/b"],
      default_repo_full_name: null,
    });
    mocks.resolveScopedRepos.mockResolvedValue(scoped("deny", [], []));

    await expect(resolveRepoCredsForRun("t1", {})).rejects.toThrow(
      /no repositories are selected for Zavi to reach/i,
    );
    expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the resolver THROWS (never reverts to the raw connected list)", async () => {
    installConnectorMeta({
      installation_id: 99,
      repo_full_names: ["acme/a", "acme/b"],
      default_repo_full_name: null,
    });
    mocks.resolveScopedRepos.mockRejectedValue(new Error("boom"));

    await expect(resolveRepoCredsForRun("t1", {})).rejects.toThrow(
      /no repositories are selected for Zavi to reach/i,
    );
    expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
  });

  it("GRANDFATHER (mode 'all') lists ALL connected repos in needs_pick (byte-unchanged)", async () => {
    installConnectorMeta({
      installation_id: 99,
      repo_full_names: ["acme/a", "acme/b"],
      default_repo_full_name: null,
    });
    mocks.resolveScopedRepos.mockResolvedValue(
      scoped("all", ["acme/a", "acme/b"], ["acme/a", "acme/b"]),
    );

    const result = await resolveRepoCredsForRun("t1", {});
    expect(result.kind).toBe("needs_pick");
    if (result.kind === "needs_pick") {
      expect(result.repos).toEqual(["acme/a", "acme/b"]);
    }
    expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
  });

  it("PROVISIONED path is untouched — never consults the scope resolver", async () => {
    mocks.assertProvisioned.mockResolvedValueOnce({
      ok: true,
      github_full_name: "praxis-co/tenant-app",
    });
    const prevToken = process.env.GITHUB_PROVISION_TOKEN;
    process.env.GITHUB_PROVISION_TOKEN = "ghp_umbrella";
    try {
      const result = await resolveRepoCredsForRun("t1", {
        stage: "build",
        target: {
          github_full_name: "praxis-co/tenant-app",
          github_target_mode: "umbrella",
        },
      });
      expect(result.kind).toBe("resolved");
      if (result.kind === "resolved") {
        expect(result.provisioned).toBe(true);
        expect(result.repo_full_name).toBe("praxis-co/tenant-app");
      }
      expect(mocks.resolveScopedRepos).not.toHaveBeenCalled();
    } finally {
      if (prevToken === undefined) delete process.env.GITHUB_PROVISION_TOKEN;
      else process.env.GITHUB_PROVISION_TOKEN = prevToken;
    }
  });
});
