
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertProvisionedRepoTarget: vi.fn(),
  mintInstallationToken: vi.fn(async () => "ghs_installtoken"),
  serviceClientMock: vi.fn(),
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/provisioning/provisioned-repo-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/provisioning/provisioned-repo-gate")>()),
  assertProvisionedRepoTarget: mocks.assertProvisionedRepoTarget,
}));
vi.mock("@/services/connectors/github/oauth", () => ({
  mintInstallationToken: mocks.mintInstallationToken,
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: mocks.serviceClientMock,
}));

vi.mock("@/services/agents/runner", () => ({
  AgentNotFoundError: class AgentNotFoundError extends Error {},
  buildContext: vi.fn(), claimAgentRun: vi.fn(), enqueueAgentRun: vi.fn(),
  persistTerminal: vi.fn(), postRunDistill: vi.fn(), runDispatch: vi.fn(),
}));
vi.mock("@/services/memory/takes-service", () => ({ recordAgentTake: vi.fn() }));
vi.mock("@/agents/index", () => ({ postProcessors: {} }));
vi.mock("@/services/agents/progress", () => ({ makeEmitProgress: () => vi.fn() }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/sandbox/lifecycle", () => ({
  bootstrapRepoIfNeeded: vi.fn(), injectSandboxSecrets: vi.fn(), pauseAndMarkPaused: vi.fn(),
  resolveSandboxForRun: vi.fn(), resolveStoredDefaultBranch: vi.fn(), wipeSandboxSecrets: vi.fn(),
}));
vi.mock("@/services/sandbox/run-worktree", () => ({
  createRunWorktree: vi.fn(), reapOrphanWorktrees: vi.fn(), removeRunWorktree: vi.fn(),
}));
vi.mock("@/services/sandbox/e2b-client", () => ({ extendSandboxTimeout: vi.fn() }));
vi.mock("@/services/sandbox/keepalive-flag", () => ({ getTenantSandboxKeepalive: vi.fn() }));
vi.mock("@/services/sandbox/browser-mcp/anchor-backend", () => ({
  closeAnchorRun: vi.fn(),
  anchorBackend: { runOp: vi.fn() },
  getBrowserActionEmitter: vi.fn(() => ({ emit: vi.fn() })),
  BROWSER_ACTION_DECISION_CLASS: "browser_action",
}));
vi.mock("@/services/sandbox/browser-mcp/backend", () => ({
  _clearRunBrowserState: vi.fn(),
}));
vi.mock("@/services/agents/cron-summary", () => ({ writeCronRunSummary: vi.fn() }));
vi.mock("@/services/sandbox/repo-picker", () => ({ pickRepoForTask: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/agents/predictions", () => ({ recordPredictions: vi.fn() }));

import { resolveRepoCredsForRun } from "../run-agent";

const TENANT = "t-1";
const PROV_REPO = "praxis-built/acme";

beforeEach(() => {
  mocks.assertProvisionedRepoTarget.mockReset();
  mocks.mintInstallationToken.mockClear();
  mocks.serviceClientMock.mockReset();
  process.env.GITHUB_PROVISION_TOKEN = "ghp_umbrella";
});

describe("resolveRepoCredsForRun — autopilot product-build hook", () => {
  it("scaffold node with provisioned target → pins provisioned repo + umbrella token, bypasses connected gate", async () => {
    mocks.assertProvisionedRepoTarget.mockResolvedValueOnce({ ok: true, github_full_name: PROV_REPO });
    mocks.serviceClientMock.mockImplementation(() => {
      throw new Error("connector_metadata should not be read on the autopilot path");
    });

    const res = await resolveRepoCredsForRun(TENANT, {
      stage: "scaffold",
      target: { github_full_name: PROV_REPO },
    });

    expect(res.kind).toBe("resolved");
    if (res.kind === "resolved") {
      expect(res.repo_full_name).toBe(PROV_REPO);
      expect(res.owner).toBe("praxis-built");
      expect(res.repo).toBe("acme");
      expect(res.installation_token).toBe("ghp_umbrella");
    }
    expect(mocks.assertProvisionedRepoTarget).toHaveBeenCalledWith(TENANT, PROV_REPO);
    expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
  });

  it("build node honors the same hook", async () => {
    mocks.assertProvisionedRepoTarget.mockResolvedValueOnce({ ok: true, github_full_name: PROV_REPO });
    const res = await resolveRepoCredsForRun(TENANT, {
      stage: "build",
      target: { github_full_name: PROV_REPO },
    });
    expect(res.kind).toBe("resolved");
  });

  it("forged target (gate fails) → THROWS (fail-closed, never resolves to an arbitrary repo)", async () => {
    mocks.assertProvisionedRepoTarget.mockResolvedValueOnce({ ok: false, reason: "not provisioned" });
    await expect(
      resolveRepoCredsForRun(TENANT, {
        stage: "build",
        target: { github_full_name: "rravi149/praxis" },
      }),
    ).rejects.toThrow(/provisioned-repo gate failed/);
  });

  it("missing GITHUB_PROVISION_TOKEN → THROWS (cannot clone/push provisioned repo)", async () => {
    delete process.env.GITHUB_PROVISION_TOKEN;
    mocks.assertProvisionedRepoTarget.mockResolvedValueOnce({ ok: true, github_full_name: PROV_REPO });
    await expect(
      resolveRepoCredsForRun(TENANT, { stage: "scaffold", target: { github_full_name: PROV_REPO } }),
    ).rejects.toThrow(/GITHUB_PROVISION_TOKEN not configured/);
  });
});

describe("resolveRepoCredsForRun — P0 fix: missing target + provisioned tenant_resources", () => {
  it("scaffold node with NO target.github_full_name → server-side lookup resolves provisioned repo, uses umbrella token", async () => {
    mocks.assertProvisionedRepoTarget.mockResolvedValueOnce({ ok: true, github_full_name: PROV_REPO });
    mocks.serviceClientMock.mockImplementation(() => ({
      from: (table: string) => {
        if (table === "tenant_resources") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { mode: "provisioned", external_ref: { github_full_name: PROV_REPO } },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected serviceClient().from("${table}") on provisioned fallback path`);
      },
    }));

    const res = await resolveRepoCredsForRun(TENANT, { stage: "scaffold" });

    expect(res.kind).toBe("resolved");
    if (res.kind === "resolved") {
      expect(res.repo_full_name).toBe(PROV_REPO);
      expect(res.owner).toBe("praxis-built");
      expect(res.repo).toBe("acme");
      expect(res.installation_token).toBe("ghp_umbrella");
    }
    expect(mocks.assertProvisionedRepoTarget).toHaveBeenCalledWith(TENANT, PROV_REPO);
    expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
  });

  it("build node with empty target object (github_full_name missing) → server-side lookup, umbrella token", async () => {
    mocks.assertProvisionedRepoTarget.mockResolvedValueOnce({ ok: true, github_full_name: PROV_REPO });
    mocks.serviceClientMock.mockImplementation(() => ({
      from: (table: string) => {
        if (table === "tenant_resources") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { mode: "provisioned", external_ref: { github_full_name: PROV_REPO } },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected serviceClient().from("${table}")`);
      },
    }));

    const res = await resolveRepoCredsForRun(TENANT, {
      stage: "build",
      target: {},
    });

    expect(res.kind).toBe("resolved");
    if (res.kind === "resolved") {
      expect(res.installation_token).toBe("ghp_umbrella");
    }
    expect(mocks.assertProvisionedRepoTarget).toHaveBeenCalledWith(TENANT, PROV_REPO);
  });

  it("scaffold node, NO target, NO tenant_resources provisioned row → falls through to connected-repo gate", async () => {
    mocks.serviceClientMock.mockImplementation(() => ({
      from: (table: string) => {
        if (table === "tenant_resources") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "connector_metadata") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { installation_id: 5, repo_full_names: ["acme/site"], default_repo_full_name: null },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    }));

    const res = await resolveRepoCredsForRun(TENANT, {
      stage: "scaffold",
      repo_hint: "acme/site",
    });
    expect(res.kind).toBe("resolved");
    if (res.kind === "resolved") {
      expect(res.repo_full_name).toBe("acme/site");
      expect(res.installation_token).toBe("ghs_installtoken");
    }
    expect(mocks.assertProvisionedRepoTarget).not.toHaveBeenCalled();
    expect(mocks.mintInstallationToken).toHaveBeenCalled();
  });
});

describe("resolveRepoCredsForRun — user_repo path (Phase 1.5 connect-existing)", () => {
  it("scaffold node with github_target_mode='user_repo' → skips provisioned gate, uses connected-repo path", async () => {
    mocks.serviceClientMock.mockImplementation(() => ({
      from: (table: string) => {
        if (table === "connector_metadata") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      installation_id: 42,
                      repo_full_names: ["acme/myrepo"],
                      default_repo_full_name: "acme/myrepo",
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table} on user_repo path`);
      },
    }));

    const res = await resolveRepoCredsForRun(TENANT, {
      stage: "scaffold",
      target: { github_full_name: "acme/myrepo", github_target_mode: "user_repo" },
    });

    expect(mocks.assertProvisionedRepoTarget).not.toHaveBeenCalled();
    expect(res.kind).toBe("resolved");
    if (res.kind === "resolved") {
      expect(res.repo_full_name).toBe("acme/myrepo");
      expect(res.installation_token).toBe("ghs_installtoken");
    }
    expect(mocks.mintInstallationToken).toHaveBeenCalled();
  });

  it("build node with github_target_mode='user_repo' → same: connected-repo path, no provisioned gate", async () => {
    mocks.serviceClientMock.mockImplementation(() => ({
      from: (table: string) => {
        if (table === "connector_metadata") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      installation_id: 8,
                      repo_full_names: ["acme/myrepo"],
                      default_repo_full_name: null,
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    }));

    const res = await resolveRepoCredsForRun(TENANT, {
      stage: "build",
      target: { github_full_name: "acme/myrepo", github_target_mode: "user_repo" },
    });

    expect(mocks.assertProvisionedRepoTarget).not.toHaveBeenCalled();
    expect(res.kind).toBe("resolved");
    if (res.kind === "resolved") {
      expect(res.installation_token).toBe("ghs_installtoken");
    }
  });
});

describe("resolveRepoCredsForRun — non-autopilot path unchanged", () => {
  it("a target present but stage is NOT scaffold/build → uses the connected-repo path (gate not consulted)", async () => {
    mocks.serviceClientMock.mockImplementation(() => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  installation_id: 99,
                  repo_full_names: ["acme/site"],
                  default_repo_full_name: null,
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
    }));
    const res = await resolveRepoCredsForRun(TENANT, {
      stage: "qa",
      target: { github_full_name: PROV_REPO },
      repo_hint: "acme/site",
    });
    expect(mocks.assertProvisionedRepoTarget).not.toHaveBeenCalled();
    expect(res.kind).toBe("resolved");
    if (res.kind === "resolved") {
      expect(res.repo_full_name).toBe("acme/site");
      expect(res.installation_token).toBe("ghs_installtoken");
    }
    expect(mocks.mintInstallationToken).toHaveBeenCalled();
  });

  it("plain chat run (no stage, no target) → connected-repo path, single connected repo auto-resolves", async () => {
    mocks.serviceClientMock.mockImplementation(() => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { installation_id: 7, repo_full_names: ["acme/only"], default_repo_full_name: null },
                error: null,
              }),
            }),
          }),
        }),
      }),
    }));
    const res = await resolveRepoCredsForRun(TENANT, { repo_hint: "acme/only" });
    expect(mocks.assertProvisionedRepoTarget).not.toHaveBeenCalled();
    expect(res.kind).toBe("resolved");
    if (res.kind === "resolved") expect(res.repo_full_name).toBe("acme/only");
  });
});
