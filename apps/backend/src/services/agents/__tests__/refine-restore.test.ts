import { describe, it, expect, vi } from "vitest";
import {
  refineRestore,
  resolveVersionCommit,
  NothingToRestore,
  NotProvisioned,
  type RefineUndoDeps,
} from "@/services/agents/refine-undo";
import { OldSiteFrozen } from "@/services/sites/old-site-freeze";

async function resolved(a: { tenant_id: string; conductor_run_id: string }, d: RefineUndoDeps) {
  const v = await resolveVersionCommit({ ...a, purpose: "restore" }, d);
  return { restored_commit_sha: v.commit_sha, label: v.label };
}

const SHA_R1 = "1111567890aaaa567890aaaa567890aaaa567890";
const SHA_R2 = "2222567890aaaa567890aaaa567890aaaa567890";
const SHA_BUILD = "0000567890aaaa567890aaaa567890aaaa567890";
const TARGET = { github_full_name: "praxis-built/acme", default_branch: "main" };

function refine(id: string, sha: string | null, message = `refine ${id}`) {
  return {
    conductor_run_id: id,
    child_run_id: `ar_${id}`,
    output_text: "shipped",
    parsed: sha ? { commit_sha: sha, title: message } : { title: message, head_branch: "engineer/x", base_branch: "main" },
    message,
  };
}

type Mocked = RefineUndoDeps & {
  restoreOnMain: ReturnType<typeof vi.fn>;
  readCommitParentSha: ReturnType<typeof vi.fn>;
  insertUndoRun: ReturnType<typeof vi.fn>;
  revertOnMain: ReturnType<typeof vi.fn>;
  loadShippedRefineById: ReturnType<typeof vi.fn>;
  loadEarliestShippedRefine: ReturnType<typeof vi.fn>;
  listRecentCommits: ReturnType<typeof vi.fn>;
  listBranches?: ReturnType<typeof vi.fn>;
  loadBuildRootRun?: ReturnType<typeof vi.fn>;
  loadRestoreRun?: ReturnType<typeof vi.fn>;
};

function deps(over: Partial<RefineUndoDeps> = {}): Mocked {
  return {
    loadLatestShippedRefine: vi.fn().mockResolvedValue(refine("r2", SHA_R2)),
    loadProvisionedTarget: vi.fn().mockResolvedValue({ ...TARGET }),
    assertProvisionedRepo: {
      loadRepoResource: vi.fn().mockResolvedValue({ mode: "provisioned", external_ref: { github_full_name: TARGET.github_full_name } }),
    },
    resolveInstallation: vi.fn().mockResolvedValue(-1),
    readBranchHeadSha: vi.fn().mockResolvedValue(null),
    listRecentCommits: vi.fn().mockResolvedValue([]),
    revertOnMain: vi.fn(),
    insertUndoRun: vi.fn().mockResolvedValue("cr_restore_1"),
    loadShippedRefineById: vi.fn(async (_t: string, id: string) => (id === "r1" ? refine("r1", SHA_R1, "Darker hero") : id === "r2" ? refine("r2", SHA_R2) : null)),
    loadEarliestShippedRefine: vi.fn().mockResolvedValue(refine("r1", SHA_R1, "Darker hero")),
    loadBuildCheckpointSha: vi.fn().mockResolvedValue(null),
    readCommitParentSha: vi.fn().mockResolvedValue(SHA_BUILD),
    restoreOnMain: vi.fn().mockResolvedValue({ restored: true, branch: "main", new_commit_sha: "9999567890aaaa567890aaaa567890aaaa567890", noop: false }),
    ...over,
  } as unknown as Mocked;
}

describe("refineRestore: the old-flow app is frozen", () => {
  it("refuses with OldSiteFrozen and never touches the repo", async () => {
    const d = deps();
    await expect(refineRestore({ tenant_id: "t1", conductor_run_id: "r1" }, d)).rejects.toBeInstanceOf(OldSiteFrozen);
    expect(d.restoreOnMain).not.toHaveBeenCalled();
    expect(d.insertUndoRun).not.toHaveBeenCalled();
    expect(d.loadProvisionedTarget).not.toHaveBeenCalled();
  });
});

describe("version commit resolution (shared with preview)", () => {
  it("an OLDER change resolves to that change's own commit and label", async () => {
    const r = await resolved({ tenant_id: "t1", conductor_run_id: "r1" }, deps());
    expect(r).toMatchObject({ restored_commit_sha: SHA_R1, label: "Darker hero" });
  });

  it("the original build uses the build's own pushed checkpoint commit when the run recorded one", async () => {
    const d = deps({ loadBuildCheckpointSha: vi.fn().mockResolvedValue(SHA_BUILD) });
    const r = await resolved({ tenant_id: "t1", conductor_run_id: "build-run" }, d);
    expect(d.loadBuildCheckpointSha).toHaveBeenCalledWith("t1", "build-run");
    expect(d.readCommitParentSha).not.toHaveBeenCalled();
    expect(d.loadEarliestShippedRefine).not.toHaveBeenCalled();
    expect(r).toMatchObject({ restored_commit_sha: SHA_BUILD, label: "the original build" });
  });

  it("the original build falls back to the parent of the FIRST shipped change", async () => {
    const d = deps();
    const r = await resolved({ tenant_id: "t1", conductor_run_id: "build-run" }, d);
    expect(d.readCommitParentSha.mock.calls[0][0]).toMatchObject({ commit_sha: SHA_R1 });
    expect(r.restored_commit_sha).toBe(SHA_BUILD);
  });

  it("the original build with no shipped change yet has nothing to resolve", async () => {
    const d = deps({ loadEarliestShippedRefine: vi.fn().mockResolvedValue(null) });
    await expect(resolved({ tenant_id: "t1", conductor_run_id: "build-run" }, d)).rejects.toBeInstanceOf(NothingToRestore);
  });

  it("a version whose commit cannot be resolved refuses instead of guessing", async () => {
    const d = deps({ loadShippedRefineById: vi.fn().mockResolvedValue(refine("r1", null)) });
    await expect(resolved({ tenant_id: "t1", conductor_run_id: "r1" }, d)).rejects.toBeInstanceOf(NothingToRestore);
  });

  it("the provisioned-repo gate stays engaged: a foreign repo is refused", async () => {
    const d = deps({
      assertProvisionedRepo: { loadRepoResource: vi.fn().mockResolvedValue({ mode: "provisioned", external_ref: { github_full_name: "someone/else" } }) },
    });
    await expect(resolved({ tenant_id: "t1", conductor_run_id: "r1" }, d)).rejects.toBeInstanceOf(NotProvisioned);
  });
});

describe("resolving an old change whose branch is gone and whose title drifted", () => {
  it("falls back to the commit on the default branch authored during that change's run", async () => {
    const d = deps({
      loadShippedRefineById: vi.fn().mockResolvedValue({
        ...refine("r1", null, "Polish Northline"),
        created_at: "2026-09-24T10:02:11.000Z",
        finished_at: "2026-09-24T10:17:41.000Z",
      }),
      readBranchHeadSha: vi.fn().mockResolvedValue(null),
      listRecentCommits: vi.fn().mockResolvedValue([
        { sha: "7ac29e30c2663020934d39b0cf0a83a02e4ac3a0", message: "Rebrand", author_date: "2026-09-25T06:40:00Z" },
        { sha: "d93e5fe0c2663020934d39b0cf0a83a02e4ac3a0", message: "Northline polish: cinematic midnight hero", author_date: "2026-09-24T10:15:30Z" },
        { sha: "33f18690c2663020934d39b0cf0a83a02e4ac3a0", message: "Wire real photos", author_date: "2026-09-24T09:50:00Z" },
        { sha: "5366afb0c2663020934d39b0cf0a83a02e4ac3a0", message: "Scaffold", author_date: "2026-09-24T07:10:00Z" },
      ]),
    });
    const r = await resolved({ tenant_id: "t1", conductor_run_id: "r1" }, d);
    expect(r.restored_commit_sha).toBe("d93e5fe0c2663020934d39b0cf0a83a02e4ac3a0");
  });

  it("two commits inside the window: the newest one is the change's final state", async () => {
    const d = deps({
      loadShippedRefineById: vi.fn().mockResolvedValue({ ...refine("r1", null, "X"), created_at: "2026-09-24T10:00:00Z", finished_at: "2026-09-24T10:20:00Z" }),
      readBranchHeadSha: vi.fn().mockResolvedValue(null),
      listRecentCommits: vi.fn().mockResolvedValue([
        { sha: "aaaa5670c2663020934d39b0cf0a83a02e4ac3a0", message: "second", author_date: "2026-09-24T10:18:00Z" },
        { sha: "bbbb5670c2663020934d39b0cf0a83a02e4ac3a0", message: "first", author_date: "2026-09-24T10:05:00Z" },
      ]),
    });
    const r = await resolved({ tenant_id: "t1", conductor_run_id: "r1" }, d);
    expect(r.restored_commit_sha).toBe("aaaa5670c2663020934d39b0cf0a83a02e4ac3a0");
  });

  it("no commit in the window: still refuses rather than guessing a neighbour", async () => {
    const d = deps({
      loadShippedRefineById: vi.fn().mockResolvedValue({ ...refine("r1", null, "X"), created_at: "2026-09-24T10:00:00Z", finished_at: "2026-09-24T10:20:00Z" }),
      readBranchHeadSha: vi.fn().mockResolvedValue(null),
      listRecentCommits: vi.fn().mockResolvedValue([
        { sha: "aaaa5670c2663020934d39b0cf0a83a02e4ac3a0", message: "later", author_date: "2026-09-24T12:00:00Z" },
        { sha: "bbbb5670c2663020934d39b0cf0a83a02e4ac3a0", message: "earlier", author_date: "2026-09-24T09:00:00Z" },
      ]),
    });
    await expect(resolved({ tenant_id: "t1", conductor_run_id: "r1" }, d)).rejects.toBeInstanceOf(NothingToRestore);
  });
});

describe("a parked change that never merged resolves to its own branch head", () => {
  const run = { created_at: "2026-09-24T10:02:11Z", finished_at: "2026-09-24T10:17:41Z" };
  const main = [
    { sha: "7ac29e30c2663020934d39b0cf0a83a02e4ac3a0", message: "Rebrand", author_date: "2026-09-25T06:40:00Z" },
    { sha: "7c0b91310697b11f8fa2927e65a8a9ff15838574", message: "Elevate hero", author_date: "2026-09-24T07:15:19Z" },
  ];
  const branchHeads: Record<string, { sha: string; message: string; author_date: string }> = {
    "engineer/polish-northline-landing-editorial-cover-hero-cf58fcee": { sha: "b74965a1bd4ef7ecbd78f6cf397cffaf53982895", message: "Polish", author_date: "2026-09-24T10:16:02Z" },
    "engineer/northline-real-hero-fleet-photos-sharper-copy-56f40462": { sha: "2142ea27b5dded2fb7afbf8c65ced390ff9bec99", message: "Photos", author_date: "2026-09-24T11:00:00Z" },
  };
  function parkedDeps() {
    return deps({
      loadShippedRefineById: vi.fn().mockResolvedValue({ ...refine("r1", null, "Polish Northline"), parsed: { repo: "praxis-built/acme", head_branch: "engineer/northline-polish", title: "Polish Northline" }, ...run }),
      readBranchHeadSha: vi.fn().mockResolvedValue(null),
      listRecentCommits: vi.fn(async (p: { branch: string }) => (p.branch === "main" ? main : branchHeads[p.branch] ? [branchHeads[p.branch]] : [])),
      listBranches: vi.fn().mockResolvedValue([
        { name: "main", sha: main[0].sha },
        ...Object.entries(branchHeads).map(([name, h]) => ({ name, sha: h.sha })),
      ]),
    });
  }

  it("picks the branch whose head was authored during the change's run, never a branch from a later change", async () => {
    const d = parkedDeps();
    const r = await resolved({ tenant_id: "t1", conductor_run_id: "r1" }, d);
    expect(r.restored_commit_sha).toBe("b74965a1bd4ef7ecbd78f6cf397cffaf53982895");
    expect(d.listRecentCommits.mock.calls.some((c) => (c[0] as { branch: string }).branch === "main")).toBe(true);
  });

  it("without a branch lister it still refuses instead of guessing", async () => {
    const d = parkedDeps();
    d.listBranches = undefined;
    await expect(resolved({ tenant_id: "t1", conductor_run_id: "r1" }, d)).rejects.toBeInstanceOf(NothingToRestore);
  });
});

describe("the original build's commit for runs that predate the checkpoint model", () => {
  it("reads the first refine's pre_refine_sha as the build's state", async () => {
    const { preRefineShaFromGraph, checkpointShaFromGraph } = await import("@/services/agents/refine-undo");
    expect(checkpointShaFromGraph([{ payload: { stage: "build" } }, { checkpoint: { commit_sha: "7c0b91310697b11f8fa2927e65a8a9ff15838574" } }])).toBe("7c0b91310697b11f8fa2927e65a8a9ff15838574");
    expect(checkpointShaFromGraph([{ payload: {} }])).toBeNull();
    expect(preRefineShaFromGraph([{ payload: { stage: "build", refine_mode: true } }, { payload: { stage: "deploy", pre_refine_sha: "7c0b91310697b11f8fa2927e65a8a9ff15838574" } }])).toBe("7c0b91310697b11f8fa2927e65a8a9ff15838574");
    expect(preRefineShaFromGraph([{ payload: { pre_refine_sha: "not a sha" } }])).toBeNull();
  });
});

describe("review fixes: restore never guesses across changes, never merges an unapproved change, never restores an unknown id", () => {
  it("the run window closes at the next change's start, so a neighbouring commit is never picked", async () => {
    const d = deps({
      loadShippedRefineById: vi.fn().mockResolvedValue({
        ...refine("r1", null, "Older"),
        created_at: "2026-09-24T10:00:00Z",
        finished_at: "2026-09-24T10:10:00Z",
        next_started_at: "2026-09-24T10:12:00Z",
      }),
      readBranchHeadSha: vi.fn().mockResolvedValue(null),
      listRecentCommits: vi.fn().mockResolvedValue([
        { sha: "aaaa5670c2663020934d39b0cf0a83a02e4ac3a0", message: "later change", author_date: "2026-09-24T10:20:00Z" },
        { sha: "bbbb5670c2663020934d39b0cf0a83a02e4ac3a0", message: "older change", author_date: "2026-09-24T10:09:00Z" },
      ]),
      listBranches: vi.fn().mockResolvedValue([]),
    });
    const r = await resolved({ tenant_id: "t1", conductor_run_id: "r1" }, d);
    expect(r.restored_commit_sha).toBe("bbbb5670c2663020934d39b0cf0a83a02e4ac3a0");
  });

  it("a parked change waiting for approval cannot be reverted to (that would merge it), but can still be previewed", async () => {
    const { resolveVersionCommit, ChangeAwaitingApproval } = await import("@/services/agents/refine-undo");
    const d = deps({ loadShippedRefineById: vi.fn().mockResolvedValue({ ...refine("r1", SHA_R1, "Parked"), awaiting_review: true }) });
    await expect(resolved({ tenant_id: "t1", conductor_run_id: "r1" }, d)).rejects.toBeInstanceOf(ChangeAwaitingApproval);
    const v = await resolveVersionCommit({ tenant_id: "t1", conductor_run_id: "r1", purpose: "preview" }, d);
    expect(v.commit_sha).toBe(SHA_R1);
  });

  it("an id that is neither a shipped change nor this tenant's build root is refused instead of restoring the original build", async () => {
    const d = deps({ loadShippedRefineById: vi.fn().mockResolvedValue(null), loadBuildRootRun: vi.fn().mockResolvedValue(null), loadBuildCheckpointSha: vi.fn().mockResolvedValue(SHA_BUILD) });
    await expect(resolved({ tenant_id: "t1", conductor_run_id: "not-a-run" }, d)).rejects.toBeInstanceOf(NothingToRestore);
    expect(d.loadBuildRootRun).toHaveBeenCalledWith("t1", "not-a-run");
  });
});

describe("second review round", () => {
  it("a parked change that was later merged on GitHub counts as approved for restore", async () => {
    const d = deps({
      loadShippedRefineById: vi.fn().mockResolvedValue({ ...refine("r1", SHA_R1, "Merged later"), awaiting_review: false }),
    });
    const r = await resolved({ tenant_id: "t1", conductor_run_id: "r1" }, d);
    expect(r.restored_commit_sha).toBe(SHA_R1);
  });
});

describe("a 'Reverted to …' history row is a version too", () => {
  it("previews and restores from the commit that revert recorded", async () => {
    const { resolveVersionCommit } = await import("@/services/agents/refine-undo");
    const d = deps({
      loadShippedRefineById: vi.fn().mockResolvedValue(null),
      loadRestoreRun: vi.fn(async (_t: string, id: string) => (id === "restore-1" ? { commit_sha: SHA_BUILD, label: "Darker hero" } : null)),
      loadBuildRootRun: vi.fn().mockResolvedValue(null),
    });
    const v = await resolveVersionCommit({ tenant_id: "t1", conductor_run_id: "restore-1", purpose: "preview" }, d);
    expect(v).toMatchObject({ commit_sha: SHA_BUILD, label: "Darker hero" });
    const r = await resolved({ tenant_id: "t1", conductor_run_id: "restore-1" }, d);
    expect(r.restored_commit_sha).toBe(SHA_BUILD);
    expect(d.loadBuildRootRun).not.toHaveBeenCalled();
  });

  it("reads the restore row once, so a row that vanishes between two reads cannot crash the restore", async () => {
    const { resolveVersionCommit } = await import("@/services/agents/refine-undo");
    const loadRestoreRun = vi
      .fn()
      .mockResolvedValueOnce({ commit_sha: SHA_BUILD, label: "Darker hero" })
      .mockResolvedValue(null);
    const d = deps({
      loadShippedRefineById: vi.fn().mockResolvedValue(null),
      loadRestoreRun,
      loadBuildRootRun: vi.fn().mockResolvedValue(null),
    });
    const v = await resolveVersionCommit({ tenant_id: "t1", conductor_run_id: "restore-1", purpose: "restore" }, d);
    expect(v).toMatchObject({ commit_sha: SHA_BUILD, label: "Darker hero" });
    expect(loadRestoreRun).toHaveBeenCalledTimes(1);
  });

  it("a shipped change never pays for a restore-row lookup", async () => {
    const { resolveVersionCommit } = await import("@/services/agents/refine-undo");
    const loadRestoreRun = vi.fn().mockResolvedValue(null);
    const d = deps({ loadRestoreRun });
    await resolveVersionCommit({ tenant_id: "t1", conductor_run_id: "r1", purpose: "preview" }, d);
    expect(loadRestoreRun).not.toHaveBeenCalled();
  });
});

describe("undoRowVersionSha", () => {
  const C = "c".repeat(40);
  const U = "d".repeat(40);
  it("an undo row stands for the commit the undo created, not the change it undid", async () => {
    const { undoRowVersionSha } = await import("../refine-undo");
    expect(undoRowVersionSha({ stage: "undo", reverted_commit_sha: C, new_commit_sha: U })).toBe(U);
  });
  it("a restore row stands for the snapshot it restored", async () => {
    const { undoRowVersionSha } = await import("../refine-undo");
    expect(undoRowVersionSha({ stage: "restore", reverted_commit_sha: C, new_commit_sha: U })).toBe(C);
  });

});
