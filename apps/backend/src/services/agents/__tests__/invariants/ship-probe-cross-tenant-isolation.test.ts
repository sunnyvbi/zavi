
import { describe, it, expect, vi, beforeEach } from "vitest";

const gh = {
  resolveInstallationId: vi.fn(),
  assertReadRepoMembership: vi.fn(),
  searchCommitsImpl: vi.fn(),
  readFileImpl: vi.fn(),
};
const scoped = {
  resolveScopedRepos: vi.fn(),
  getScopedRepoFullNames: vi.fn(),
};

vi.mock("@/services/mcp/internal/github", () => ({
  resolveInstallationId: (...a: unknown[]) => gh.resolveInstallationId(...a),
  assertReadRepoMembership: (...a: unknown[]) => gh.assertReadRepoMembership(...a),
  searchCommitsImpl: (...a: unknown[]) => gh.searchCommitsImpl(...a),
  readFileImpl: (...a: unknown[]) => gh.readFileImpl(...a),
}));
vi.mock("@/services/connectors/github/scoped-repos", () => ({
  resolveScopedRepos: (...a: unknown[]) => scoped.resolveScopedRepos(...a),
  getScopedRepoFullNames: (...a: unknown[]) => scoped.getScopedRepoFullNames(...a),
}));

import { repoShipProbe } from "../../repo-ship-probe";

beforeEach(() => {
  vi.clearAllMocks();
  gh.resolveInstallationId.mockResolvedValue(999);
  gh.assertReadRepoMembership.mockResolvedValue(undefined);
});

describe("INVARIANT — ship-probe cross-tenant isolation", () => {
  it("tenant B can NEVER see tenant A's repo commits (allowlist post-filter)", async () => {
    scoped.resolveScopedRepos.mockResolvedValue({
      mode: "scoped",
      repos: ["tenantA/private-app", "tenantB/app"],
      allConnected: ["tenantB/app"],
      selectionRequired: false,
    });
    scoped.getScopedRepoFullNames.mockResolvedValue(["tenantB/app"]);
    gh.searchCommitsImpl.mockImplementation(
      async (_t: string, _i: number, q: { owner: string; repo: string }) => {
        if (`${q.owner}/${q.repo}` === "tenantA/private-app") {
          return {
            total: 1,
            items: [
              {
                sha: "secret1234567",
                message: "SEC-1 tenant A confidential feature",
                url: "https://github.com/tenantA/private-app/commit/secret1234567",
                author_date: "2026-07-01T00:00:00Z",
              },
            ],
          };
        }
        return { total: 0, items: [] };
      },
    );

    const ev = await repoShipProbe("tenant-B", {
      ticketKey: "SEC-1",
      featureKeywords: ["confidential"],
    });

    for (const c of ev.shipping_commits) {
      expect(c.repo).toBe("tenantB/app");
    }
    expect(ev.shipping_commits.some((c) => c.sha === "secret1234567")).toBe(false);
    expect(ev.shipping_commits.some((c) => c.repo.startsWith("tenantA/"))).toBe(false);
  });

  it("mode === 'deny' fails closed — zero GitHub reads", async () => {
    scoped.resolveScopedRepos.mockResolvedValue({
      mode: "deny",
      repos: [],
      allConnected: [],
      selectionRequired: false,
    });
    const ev = await repoShipProbe("tenant-denied", { ticketKey: "X-1" });
    expect(ev.repo_scope_ok).toBe(false);
    expect(ev.shipping_commits).toEqual([]);
    expect(gh.searchCommitsImpl).not.toHaveBeenCalled();
    expect(gh.resolveInstallationId).not.toHaveBeenCalled();
  });
});
