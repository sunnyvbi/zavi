
import { describe, it, expect, vi } from "vitest";
import {
  refineUndo,
  resolveVersionCommit,
  extractCommitSha,
  extractShippedCommitSha,
  NoUndoableRefine,
  NotProvisioned,
  type RefineUndoDeps,
} from "@/services/agents/refine-undo";
import { OldSiteFrozen } from "@/services/sites/old-site-freeze";

const LEGACY_SHA = "abc1234def5678901234567890123456789abcde";
const STAMPED_SHA = "aaaa567890aaaa567890aaaa567890aaaa567890";
const BRANCH_SHA = "bbbb567890bbbb567890bbbb567890bbbb567890";
const TITLE_SHA = "cccc567890cccc567890cccc567890cccc567890";

const SHIPPED_REFINE = {
  conductor_run_id: "cr_shipped_1",
  child_run_id: "ar_eng_1",
  output_text: `<pr_proposal>{"summary":"changed header copy","commit_sha":"${LEGACY_SHA}","pr_url":"https://github.com/praxis-built/acme/commit/abc1234"}</pr_proposal>`,
  parsed: null as Record<string, unknown> | null,
};

const MODERN_REFINE = {
  conductor_run_id: "cr_shipped_1",
  child_run_id: "ar_eng_1",
  output_text: "Shipped the refine — updated the hero copy and pushed to main.",
  parsed: {
    repo: "praxis-built/acme",
    head_branch: "engineer/refine-built-with-zavi",
    base_branch: "main",
    title: "refine: update hero copy",
    risk_class: "low",
  } as Record<string, unknown> | null,
};

const TARGET = {
  github_full_name: "praxis-built/acme",
  default_branch: "main",
};

type MockedDeps = RefineUndoDeps & {
  loadLatestShippedRefine: ReturnType<typeof vi.fn>;
  loadProvisionedTarget: ReturnType<typeof vi.fn>;
  resolveInstallation: ReturnType<typeof vi.fn>;
  readBranchHeadSha: ReturnType<typeof vi.fn>;
  listRecentCommits: ReturnType<typeof vi.fn>;
  revertOnMain: ReturnType<typeof vi.fn>;
  insertUndoRun: ReturnType<typeof vi.fn>;
};

function deps(over: Partial<RefineUndoDeps> = {}): MockedDeps {
  return {
    loadLatestShippedRefine: vi.fn().mockResolvedValue({ ...SHIPPED_REFINE }),
    loadProvisionedTarget: vi.fn().mockResolvedValue({ ...TARGET }),
    assertProvisionedRepo: {
      loadRepoResource: vi.fn().mockResolvedValue({
        mode: "provisioned",
        external_ref: { github_full_name: TARGET.github_full_name },
      }),
    },
    resolveInstallation: vi.fn().mockResolvedValue(-1),
    readBranchHeadSha: vi.fn().mockResolvedValue(BRANCH_SHA),
    listRecentCommits: vi.fn().mockResolvedValue([
      { sha: BRANCH_SHA, message: "refine: update hero copy" },
      { sha: "dddd567890dddd567890dddd567890dddd567890", message: "seed" },
    ]),
    revertOnMain: vi.fn().mockResolvedValue({
      reverted: true,
      branch: "main",
      new_commit_sha: "rev0000000000000000000000000000000000000",
    }),
    insertUndoRun: vi.fn().mockResolvedValue("cr_undo_1"),
    ...over,
  } as MockedDeps;
}

describe("refineUndo: the old-flow app is frozen", () => {
  it("the latest old-flow change is refused with OldSiteFrozen and nothing is reverted", async () => {
    const d = deps();
    await expect(refineUndo({ tenant_id: "t1" }, d)).rejects.toBeInstanceOf(OldSiteFrozen);
    expect(d.revertOnMain).not.toHaveBeenCalled();
    expect(d.insertUndoRun).not.toHaveBeenCalled();
    expect(d.resolveInstallation).not.toHaveBeenCalled();
  });

  it("a pinned old-flow change is refused the same way", async () => {
    const d = deps();
    await expect(refineUndo({ tenant_id: "t1", conductor_run_id: "cr_whatever" }, d)).rejects.toBeInstanceOf(OldSiteFrozen);
    expect(d.revertOnMain).not.toHaveBeenCalled();
  });

  it("nothing shipped at all is still 'nothing to undo', not a freeze", async () => {
    const d = deps({ loadLatestShippedRefine: vi.fn().mockResolvedValue(null) });
    await expect(refineUndo({ tenant_id: "t1" }, d)).rejects.toBeInstanceOf(NoUndoableRefine);
  });
});

describe("extractCommitSha / extractShippedCommitSha (resolve chain)", () => {
  it("legacy envelope: reads commit_sha (and the historical `sha` alias)", () => {
    expect(
      extractCommitSha(`<pr_proposal>{"commit_sha":"${LEGACY_SHA}"}</pr_proposal>`),
    ).toBe(LEGACY_SHA);
    expect(
      extractCommitSha(`<pr_proposal>{"sha":"${LEGACY_SHA}"}</pr_proposal>`),
    ).toBe(LEGACY_SHA);
  });

  it("legacy envelope: missing / malformed / bad-sha → null", () => {
    expect(extractCommitSha(null)).toBeNull();
    expect(extractCommitSha("plain prose, no envelope")).toBeNull();
    expect(extractCommitSha("<pr_proposal>not json</pr_proposal>")).toBeNull();
    expect(
      extractCommitSha('<pr_proposal>{"commit_sha":"xyz"}</pr_proposal>'),
    ).toBeNull();
  });

  it("order of checks: parsed.commit_sha first, then the legacy envelope", () => {
    const legacy = `<pr_proposal>{"commit_sha":"${LEGACY_SHA}"}</pr_proposal>`;
    expect(extractShippedCommitSha({ commit_sha: STAMPED_SHA }, legacy)).toBe(
      STAMPED_SHA,
    );
    expect(extractShippedCommitSha({}, legacy)).toBe(LEGACY_SHA);
    expect(extractShippedCommitSha(null, legacy)).toBe(LEGACY_SHA);
    expect(extractShippedCommitSha(null, "prose only")).toBeNull();
  });

  it("malformed parsed.commit_sha never validates (7-40 hex only)", () => {
    expect(extractShippedCommitSha({ commit_sha: "HEAD~1" }, null)).toBeNull();
    expect(extractShippedCommitSha({ commit_sha: 1234567 }, null)).toBeNull();
    expect(extractShippedCommitSha({ commit_sha: "abc12" }, null)).toBeNull();
    expect(extractShippedCommitSha({ commit_sha: ` ${STAMPED_SHA} ` }, null)).toBe(
      STAMPED_SHA,
    );
  });
});

describe("resolveVersionCommit — the shared version→commit resolver", () => {
  const RESTORE_SHA = "eeee567890eeee567890eeee567890eeee567890";
  function restoreDeps(over: Partial<RefineUndoDeps> = {}): MockedDeps {
    return deps({
      loadShippedRefineById: vi.fn().mockResolvedValue({
        conductor_run_id: "cr_r1",
        child_run_id: "ar_r1",
        output_text: "shipped",
        parsed: { commit_sha: RESTORE_SHA },
        message: "Darker hero",
      }),
      loadEarliestShippedRefine: vi.fn().mockResolvedValue(null),
      loadBuildCheckpointSha: vi.fn().mockResolvedValue(null),
      readCommitParentSha: vi.fn().mockResolvedValue(null),
      restoreOnMain: vi.fn(),
      ...over,
    });
  }

  it("refuses a NON-provisioned repo before reading any version data (fail-closed gate)", async () => {
    const d = restoreDeps({
      assertProvisionedRepo: {
        loadRepoResource: vi.fn().mockResolvedValue({
          mode: "connected",
          external_ref: { github_full_name: TARGET.github_full_name },
        }),
      },
    });
    await expect(
      resolveVersionCommit({ tenant_id: "t1", conductor_run_id: "cr_r1" }, d),
    ).rejects.toBeInstanceOf(NotProvisioned);
    expect(d.loadShippedRefineById).not.toHaveBeenCalled();
    expect(d.resolveInstallation).not.toHaveBeenCalled();
    expect(d.readBranchHeadSha).not.toHaveBeenCalled();
    expect(d.restoreOnMain).not.toHaveBeenCalled();
  });

  it("refuses when the provisioned row names a DIFFERENT repo than the tenant's target", async () => {
    const d = restoreDeps({
      assertProvisionedRepo: {
        loadRepoResource: vi.fn().mockResolvedValue({
          mode: "provisioned",
          external_ref: { github_full_name: "someone/else" },
        }),
      },
    });
    await expect(
      resolveVersionCommit({ tenant_id: "t1", conductor_run_id: "cr_r1" }, d),
    ).rejects.toBeInstanceOf(NotProvisioned);
    expect(d.loadShippedRefineById).not.toHaveBeenCalled();
  });

  it("refuses when the tenant has no provisioned repo at all", async () => {
    const d = restoreDeps({ loadProvisionedTarget: vi.fn().mockResolvedValue(null) });
    await expect(
      resolveVersionCommit({ tenant_id: "t1", conductor_run_id: "cr_r1" }, d),
    ).rejects.toBeInstanceOf(NotProvisioned);
    expect(d.loadShippedRefineById).not.toHaveBeenCalled();
  });

  it("resolves a shipped refine to its commit, label, gate-approved target and installation, with no write", async () => {
    const d = restoreDeps();
    const v = await resolveVersionCommit({ tenant_id: "t1", conductor_run_id: "cr_r1" }, d);
    expect(v).toEqual({
      commit_sha: RESTORE_SHA,
      label: "Darker hero",
      target: { github_full_name: TARGET.github_full_name, default_branch: "main" },
      installation_id: -1,
    });
    expect(d.restoreOnMain).not.toHaveBeenCalled();
    expect(d.insertUndoRun).not.toHaveBeenCalled();
  });
});

describe("resolveInstallationForRepo — umbrella repos always use the umbrella credentials", () => {
  it("returns the umbrella sentinel for a Praxis-build repo even when the tenant connected its own GitHub", async () => {
    process.env.PRAXIS_GITHUB_ORG = "Praxis-build";
    const { resolveInstallationForRepo } = await import("@/services/agents/refine-undo");
    expect(await resolveInstallationForRepo("t1", "Praxis-build/mohit-93bd8436")).toBe(-1);
    expect(await resolveInstallationForRepo("t1", "praxis-BUILD/x")).toBe(-1);
  });

});
