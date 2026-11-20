
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

import { repoShipProbe } from "../repo-ship-probe";

function commit(sha: string, message: string, repository_full_name = "x/y") {
  return {
    sha,
    message,
    url: `https://github.com/${repository_full_name}/commit/${sha}`,
    author_date: "2026-07-10T00:00:00Z",
    repository_full_name,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  gh.resolveInstallationId.mockResolvedValue(12345);
  gh.assertReadRepoMembership.mockResolvedValue(undefined);
});

describe("repoShipProbe — cross-tenant isolation (E3)", () => {
  it("NEVER returns a commit from a repo outside getScopedRepoFullNames — even if the search set is wider", async () => {
    scoped.resolveScopedRepos.mockResolvedValue({
      mode: "scoped",
      repos: ["tenantA/secret", "tenantB/app"],
      allConnected: ["tenantB/app"],
      selectionRequired: false,
    });
    scoped.getScopedRepoFullNames.mockResolvedValue(["tenantB/app"]);

    gh.searchCommitsImpl.mockImplementation(
      async (_t: string, _i: number, { owner, repo }: { owner: string; repo: string }) => {
        if (`${owner}/${repo}` === "tenantA/secret") {
          return {
            total: 1,
            items: [commit("aaaaaaa1111", "TA-1 tenant A private work", "tenantA/secret")],
          };
        }
        return { total: 0, items: [] };
      },
    );

    const ev = await repoShipProbe("tenant-B", {
      ticketKey: "TA-1",
      featureKeywords: ["work"],
    });

    expect(ev.shipping_commits.every((c) => c.repo === "tenantB/app")).toBe(true);
    expect(ev.shipping_commits.some((c) => c.repo === "tenantA/secret")).toBe(false);
    expect(ev.shipping_commits.some((c) => c.sha === "aaaaaaa1111")).toBe(false);
    expect(ev.repo_scope_ok).toBe(true);
  });

  it("(finding 1) drops a commit whose RETURNED repo is non-allowlisted, even when the SEARCHED repo is allowlisted", async () => {
    scoped.resolveScopedRepos.mockResolvedValue({
      mode: "scoped",
      repos: ["tenantB/app"],
      allConnected: ["tenantB/app"],
      selectionRequired: false,
    });
    scoped.getScopedRepoFullNames.mockResolvedValue(["tenantB/app"]);
    gh.searchCommitsImpl.mockResolvedValue({
      total: 1,
      items: [commit("cccccccc333", "X-1 leaked", "tenantA/secret")],
    });

    const ev = await repoShipProbe("tenant-B", { ticketKey: "X-1" });
    expect(ev.shipping_commits).toHaveLength(0);
    expect(ev.shipping_commits.some((c) => c.sha === "cccccccc333")).toBe(false);
  });

  it("mode === 'deny' → repo_scope_ok false, ZERO github calls", async () => {
    scoped.resolveScopedRepos.mockResolvedValue({
      mode: "deny",
      repos: [],
      allConnected: [],
      selectionRequired: false,
    });

    const ev = await repoShipProbe("tenant-locked", { ticketKey: "X-1" });
    expect(ev.repo_scope_ok).toBe(false);
    expect(ev.shipping_commits).toEqual([]);
    expect(gh.resolveInstallationId).not.toHaveBeenCalled();
    expect(gh.searchCommitsImpl).not.toHaveBeenCalled();
    expect(scoped.getScopedRepoFullNames).not.toHaveBeenCalled();
  });

  it("a repo whose membership assert THROWS is skipped, not fatal", async () => {
    scoped.resolveScopedRepos.mockResolvedValue({
      mode: "scoped",
      repos: ["o/blocked", "o/ok"],
      allConnected: ["o/blocked", "o/ok"],
      selectionRequired: false,
    });
    scoped.getScopedRepoFullNames.mockResolvedValue(["o/blocked", "o/ok"]);
    gh.assertReadRepoMembership.mockImplementation(async (_t: string, owner: string, repo: string) => {
      if (`${owner}/${repo}` === "o/blocked") throw new Error("repo_not_authorized");
    });
    gh.searchCommitsImpl.mockResolvedValue({ total: 1, items: [commit("bbbbbbb2222", "OK-1 done", "o/ok")] });

    const ev = await repoShipProbe("t", { ticketKey: "OK-1" });
    expect(gh.searchCommitsImpl).not.toHaveBeenCalledWith(
      "t", 12345, expect.objectContaining({ owner: "o", repo: "blocked" }),
    );
    expect(ev.shipping_commits.some((c) => c.repo === "o/ok")).toBe(true);
    expect(ev.incomplete).toBe(false);
  });
});

describe("repoShipProbe — happy path + evidence shape", () => {
  beforeEach(() => {
    scoped.resolveScopedRepos.mockResolvedValue({
      mode: "scoped",
      repos: ["rravi149/OraiCar"],
      allConnected: ["rravi149/OraiCar"],
      selectionRequired: false,
    });
    scoped.getScopedRepoFullNames.mockResolvedValue(["rravi149/OraiCar"]);
  });

  it("returns a commit with the ticket key parsed from the message + the searched repo attributed", async () => {
    gh.searchCommitsImpl.mockResolvedValue({
      total: 1,
      items: [commit("7633339babc", "DEL-265 show top cars on empty search", "rravi149/OraiCar")],
    });
    const ev = await repoShipProbe("t", { ticketKey: "DEL-286", featureKeywords: ["getTopCars"] });
    expect(ev.shipping_commits).toHaveLength(1);
    expect(ev.shipping_commits[0].key).toBe("DEL-265");
    expect(ev.shipping_commits[0].repo).toBe("rravi149/OraiCar");
    expect(ev.repo_scope_ok).toBe(true);
    expect(ev.incomplete).toBe(false);
  });

  it("reads a contract snippet (first ~400 chars) + records contract_path when the hint repo is in the allowlist", async () => {
    gh.searchCommitsImpl.mockResolvedValue({ total: 0, items: [] });
    gh.readFileImpl.mockResolvedValue({ content: "X".repeat(1000), truncated: false });
    const ev = await repoShipProbe("t", {
      ticketKey: "DEL-286",
      contractHint: { owner: "rravi149", repo: "OraiCar", path: "src/cars.ts" },
    });
    expect(ev.contract_snippet).not.toBeNull();
    expect(ev.contract_snippet!.length).toBe(400);
    expect(ev.contract_path).toBe("src/cars.ts");
  });

  it("does NOT read a contract when the hint repo is NOT in the allowlist (E3)", async () => {
    gh.searchCommitsImpl.mockResolvedValue({ total: 0, items: [] });
    const ev = await repoShipProbe("t", {
      ticketKey: "DEL-286",
      contractHint: { owner: "someoneelse", repo: "private", path: "secret.ts" },
    });
    expect(gh.readFileImpl).not.toHaveBeenCalled();
    expect(ev.contract_snippet).toBeNull();
  });
});

describe("repoShipProbe — fail-safe (never throws out)", () => {
  it("a GitHub throw (rate-limit / 403) → incomplete true, no throw", async () => {
    scoped.resolveScopedRepos.mockResolvedValue({
      mode: "scoped",
      repos: ["o/r"],
      allConnected: ["o/r"],
      selectionRequired: false,
    });
    scoped.getScopedRepoFullNames.mockResolvedValue(["o/r"]);
    gh.searchCommitsImpl.mockRejectedValue(new Error("search_commits HTTP 403"));

    const ev = await repoShipProbe("t", { ticketKey: "X-1" });
    expect(ev.incomplete).toBe(true);
    expect(ev.shipping_commits).toEqual([]);
  });

  it("an unexpected throw anywhere (scope resolve) → fail-safe object with error, never throws", async () => {
    scoped.resolveScopedRepos.mockRejectedValue(new Error("db down"));
    const ev = await repoShipProbe("t", { ticketKey: "X-1" });
    expect(ev.incomplete).toBe(true);
    expect(ev.repo_scope_ok).toBe(false);
    expect(ev.error).toMatch(/db down/);
  });

  it("caps the GitHub fan-out (≤ 12 calls) and marks incomplete when the cap is hit", async () => {
    const many = Array.from({ length: 10 }, (_, i) => `o/r${i}`);
    scoped.resolveScopedRepos.mockResolvedValue({
      mode: "scoped",
      repos: many,
      allConnected: many,
      selectionRequired: false,
    });
    scoped.getScopedRepoFullNames.mockResolvedValue(many);
    gh.searchCommitsImpl.mockResolvedValue({ total: 0, items: [] });

    const ev = await repoShipProbe("t", {
      ticketKey: "X-1",
      featureKeywords: ["a", "b"],
    });
    expect(gh.searchCommitsImpl.mock.calls.length).toBeLessThanOrEqual(12);
    expect(ev.incomplete).toBe(true);
  });
});
