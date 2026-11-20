
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClientMock: vi.fn(),
  mintInstallationToken: vi.fn(async () => "ghs_minted"),
  resolveScopedRepos: vi.fn(async () => ({ mode: "all", repos: [] as string[] })),
}));

vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/connectors/github/oauth", () => ({
  mintInstallationToken: mocks.mintInstallationToken,
}));
vi.mock("@/services/connectors/github/scoped-repos", () => ({
  resolveScopedRepos: mocks.resolveScopedRepos,
}));

import { resolveRepoCredsForRun } from "../repo-creds";

const PROVISIONED_REPO = "Praxis-build/build-a-modern-clinic-1f02d7f0";
const TENANT = "42624c1f-f863-44a9-95bd-ca4ee9983f1d";

function installDb(opts: {
  repoRow?: { mode: string; external_ref: Record<string, unknown> } | null;
  repoError?: { message: string } | null;
  connectorRow?: {
    installation_id?: number | null;
    repo_full_names?: string[];
    default_repo_full_name?: string | null;
    account_login?: string | null;
  } | null;
}) {
  mocks.serviceClientMock.mockReturnValue({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () =>
              table === "tenant_resources"
                ? { data: opts.repoRow ?? null, error: opts.repoError ?? null }
                : { data: opts.connectorRow ?? null, error: null },
          }),
        }),
      }),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_PROVISION_TOKEN = "ghp_umbrella_test";
  mocks.resolveScopedRepos.mockResolvedValue({ mode: "all", repos: [] });
});

describe("bare customer edit on an umbrella-provisioned app", () => {
  it("resolves the provisioned repo through the REAL gate, with no stage and no target", async () => {
    installDb({
      repoRow: {
        mode: "provisioned",
        external_ref: { github_full_name: PROVISIONED_REPO },
      },
      connectorRow: {
        installation_id: null,
        repo_full_names: [PROVISIONED_REPO],
      },
    });

    const res = await resolveRepoCredsForRun(TENANT, {
      task_description: "fix the waitlist referral_code column",
      source_agent: "chat",
    });

    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.provisioned).toBe(true);
    expect(res.repo_full_name).toBe(PROVISIONED_REPO);
    expect(res.owner).toBe("Praxis-build");
    expect(res.installation_token).toBe("ghp_umbrella_test");

    expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
    expect(mocks.resolveScopedRepos).not.toHaveBeenCalled();
  });

  it("still refuses when the tenant has no provisioned repo (unchanged behavior)", async () => {
    installDb({
      repoRow: null,
      connectorRow: { installation_id: null, repo_full_names: [] },
    });

    await expect(
      resolveRepoCredsForRun(TENANT, { task_description: "do a thing" }),
    ).rejects.toThrow(/GitHub App not connected/);
  });

  it("refuses a tenant_resources READ ERROR instead of reporting 'GitHub App not connected' (F5)", async () => {
    installDb({
      repoError: { message: "JSON object requested, multiple (or no) rows returned" },
      connectorRow: { installation_id: null, repo_full_names: [] },
    });

    const call = resolveRepoCredsForRun(TENANT, { task_description: "do a thing" });
    await expect(call).rejects.toThrow(/tenant_resources\(repo\) read failed/);
    await expect(call).rejects.not.toThrow(/Install via \/connectors/);
  });

  it("does NOT hijack a run that carries an explicit repo_hint (precedence)", async () => {
    installDb({
      repoRow: {
        mode: "provisioned",
        external_ref: { github_full_name: PROVISIONED_REPO },
      },
      connectorRow: {
        installation_id: 147981112,
        repo_full_names: ["abhijitxy56/their-own-repo"],
      },
    });
    mocks.resolveScopedRepos.mockResolvedValue({
      mode: "all",
      repos: ["abhijitxy56/their-own-repo"],
    });

    const res = await resolveRepoCredsForRun(TENANT, {
      task_description: "fix a thing",
      repo_hint: "abhijitxy56/their-own-repo",
    });

    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.installation_token).toBe("ghs_minted");
    expect(res.provisioned).toBeFalsy();
    expect(mocks.mintInstallationToken).toHaveBeenCalled();
  });

  it("an a2a handoff hinting THE PROVISIONED REPO resolves it, instead of dying at dispatch", async () => {
    installDb({
      repoRow: {
        mode: "provisioned",
        external_ref: { github_full_name: PROVISIONED_REPO },
      },
      connectorRow: {
        installation_id: null,
        repo_full_names: [PROVISIONED_REPO],
        account_login: "Praxis-build",
      },
    });

    const res = await resolveRepoCredsForRun(TENANT, {
      task_description: "add the no-show button",
      source_agent: "pm",
      repo_hint: PROVISIONED_REPO,
    });

    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.repo_full_name).toBe(PROVISIONED_REPO);
    expect(res.provisioned).toBe(true);
    expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
  });

  it("a hint naming SOMETHING ELSE still leaves this path alone", async () => {
    installDb({
      repoRow: {
        mode: "provisioned",
        external_ref: { github_full_name: PROVISIONED_REPO },
      },
      connectorRow: {
        installation_id: 147981112,
        repo_full_names: ["abhijitxy56/their-own-repo"],
      },
    });
    mocks.resolveScopedRepos.mockResolvedValue({
      mode: "all",
      repos: ["abhijitxy56/their-own-repo"],
    });

    const res = await resolveRepoCredsForRun(TENANT, {
      task_description: "fix a thing",
      repo_hint: "abhijitxy56/their-own-repo",
    });

    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.provisioned).toBeFalsy();
    expect(mocks.mintInstallationToken).toHaveBeenCalled();
  });

  it("does NOT hijack a user_repo target (unchanged path)", async () => {
    installDb({
      repoRow: {
        mode: "provisioned",
        external_ref: { github_full_name: PROVISIONED_REPO },
      },
      connectorRow: {
        installation_id: 147981112,
        repo_full_names: ["abhijitxy56/their-own-repo"],
      },
    });
    mocks.resolveScopedRepos.mockResolvedValue({
      mode: "all",
      repos: ["abhijitxy56/their-own-repo"],
    });

    const res = await resolveRepoCredsForRun(TENANT, {
      task_description: "fix a thing",
      target: {
        github_full_name: "abhijitxy56/their-own-repo",
        github_target_mode: "user_repo",
      },
    });

    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.installation_token).toBe("ghs_minted");
    expect(mocks.mintInstallationToken).toHaveBeenCalled();
  });

  it("does NOT tell an umbrella tenant to 'connect GitHub' when the provisioning row is missing", async () => {
    installDb({
      repoRow: null,
      connectorRow: {
        installation_id: null,
        repo_full_names: [PROVISIONED_REPO],
        account_login: "Praxis-build",
      },
    });

    const call = resolveRepoCredsForRun(TENANT, { task_description: "fix a thing" });
    await expect(call).rejects.toThrow(/umbrella-provisioned app/);
    await expect(call).rejects.toThrow(/server-side provisioning gap/);
    await expect(call).rejects.not.toThrow(/Install via \/connectors/);
    await expect(call).rejects.not.toThrow(/App not connected/i);
  });

  it("still says 'GitHub App not connected' for a genuine non-umbrella tenant (copy unchanged)", async () => {
    installDb({
      repoRow: null,
      connectorRow: {
        installation_id: null,
        repo_full_names: [],
        account_login: "some-real-user",
      },
    });
    await expect(
      resolveRepoCredsForRun(TENANT, { task_description: "fix a thing" }),
    ).rejects.toThrow(/GitHub App not connected/);
  });

  it("refuses when the gate's row does not match the derived target (real gate, fail-closed)", async () => {
    installDb({
      repoRow: {
        mode: "connected",
        external_ref: { github_full_name: PROVISIONED_REPO },
      },
      connectorRow: { installation_id: null, repo_full_names: [] },
    });

    await expect(
      resolveRepoCredsForRun(TENANT, { task_description: "do a thing" }),
    ).rejects.toThrow();
    expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
  });

  describe("real-install tenant with a leftover provisioned row", () => {
    const realInstallDb = () => {
      installDb({
        repoRow: {
          mode: "provisioned",
          external_ref: { github_full_name: PROVISIONED_REPO },
        },
        connectorRow: {
          installation_id: 147981112,
          repo_full_names: ["acme/web"],
          account_login: "acme",
        },
      });
      mocks.resolveScopedRepos.mockResolvedValue({ mode: "all", repos: ["acme/web"] });
    };

    it("a bare chat edit (no hint) resolves THEIR repo, never the scaffold", async () => {
      realInstallDb();
      const res = await resolveRepoCredsForRun(TENANT, {
        task_description: "fix the signup button",
        source_agent: "chat",
      });
      expect(res.kind).toBe("resolved");
      if (res.kind !== "resolved") return;
      expect(res.repo_full_name).toBe("acme/web");
      expect(res.provisioned).toBe(false);
      expect(res.installation_token).toBe("ghs_minted");
    });

    it("a hint naming the scaffold does NOT pin it (the picker re-surfaces their repos)", async () => {
      realInstallDb();
      mocks.resolveScopedRepos.mockResolvedValue({
        mode: "all",
        repos: ["acme/web", "acme/api"],
      });
      const res = await resolveRepoCredsForRun(TENANT, {
        task_description: "fix the signup button",
        repo_hint: PROVISIONED_REPO,
      });
      expect(res.kind).toBe("needs_pick");
      if (res.kind !== "needs_pick") return;
      expect(res.repos).toEqual(["acme/web", "acme/api"]);
      expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
    });

    it("a product-build stage still targets the scaffold (build nodes are unchanged)", async () => {
      realInstallDb();
      const res = await resolveRepoCredsForRun(TENANT, {
        task_description: "build it",
        stage: "build",
      });
      expect(res.kind).toBe("resolved");
      if (res.kind !== "resolved") return;
      expect(res.repo_full_name).toBe(PROVISIONED_REPO);
      expect(res.provisioned).toBe(true);
      expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
    });
  });
});
