
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClientMock: vi.fn(() => ({})),
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

import { assertReadRepoMembership } from "../github";

function setScoped(opts: {
  repos: string[];
  scoped?: boolean;
  allConnected?: string[];
  throws?: boolean;
}) {
  if (opts.throws) {
    mocks.getScopedReposMock.mockRejectedValue(new Error("config read boom"));
    return;
  }
  mocks.getScopedReposMock.mockResolvedValue({
    repos: opts.repos,
    scoped: opts.scoped ?? false,
    allConnected: opts.allConnected ?? opts.repos,
    selectionRequired: false,
  });
}

beforeEach(() => {
  mocks.getScopedReposMock.mockReset();
});

describe("assertReadRepoMembership (H6 + scoping)", () => {
  it("allows a repo in the scoped set", async () => {
    setScoped({ repos: ["acme/web", "acme/backend"] });
    await expect(
      assertReadRepoMembership("t1", "acme", "web", {
        assertProvisionedRepoTarget: async () => ({ ok: false, reason: "no row" }),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects another tenant's repo (not connected, not provisioned)", async () => {
    setScoped({ repos: ["acme/web"] });
    await expect(
      assertReadRepoMembership("t1", "victim", "secrets", {
        assertProvisionedRepoTarget: async () => ({ ok: false, reason: "no row" }),
      }),
    ).rejects.toMatchObject({ code: "repo_not_authorized" });
  });

  it("rejects an undeclared-but-install-visible repo (same org, not connected)", async () => {
    setScoped({ repos: ["acme/web"] });
    await expect(
      assertReadRepoMembership("t1", "acme", "private-billing", {
        assertProvisionedRepoTarget: async () => ({ ok: false, reason: "no row" }),
      }),
    ).rejects.toMatchObject({ code: "repo_not_authorized" });
  });

  it("rejects a CONNECTED-but-scoped-out repo when scoping is active", async () => {
    setScoped({
      repos: ["acme/web"],
      scoped: true,
      allConnected: ["acme/web", "acme/backend"],
    });
    const err = await assertReadRepoMembership("t1", "acme", "backend", {
      assertProvisionedRepoTarget: async () => ({ ok: false, reason: "no row" }),
    }).catch((e) => e);
    expect(err).toMatchObject({ code: "repo_not_authorized" });
    expect(String(err.message)).toContain("selected repositories");
  });

  it("allows the tenant's OWN provisioned umbrella repo (autopilot path)", async () => {
    setScoped({ repos: ["acme/web"] });
    await expect(
      assertReadRepoMembership("t1", "Praxis-build", "acme-app-xyz", {
        assertProvisionedRepoTarget: async (_tenant, full) => ({
          ok: true,
          github_full_name: full,
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects when github is not connected at all and not provisioned", async () => {
    setScoped({ repos: [] });
    await expect(
      assertReadRepoMembership("t1", "acme", "web", {
        assertProvisionedRepoTarget: async () => ({ ok: false, reason: "no row" }),
      }),
    ).rejects.toMatchObject({ code: "repo_not_authorized" });
  });

  it("fails closed on a scope read error", async () => {
    setScoped({ repos: [], throws: true });
    await expect(
      assertReadRepoMembership("t1", "acme", "web", {
        assertProvisionedRepoTarget: async () => ({ ok: false, reason: "no row" }),
      }),
    ).rejects.toMatchObject({ code: "github_read_membership_check_failed" });
  });
});
