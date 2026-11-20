
import { describe, it, expect, vi } from "vitest";
import {
  refineProduct,
  SitePreviewRestarting,
  SiteUnavailable,
  OldSiteFrozen,
  createSiteRepublisher,
  siteRepublishGraph,
  type RefineProductDeps,
} from "@/services/agents/refine-product";
import {
  refineUndo,
  resolveVersionCommit,
  syncSitePreviewToCommit,
  NotProvisioned,
  NoUndoableRefine,
  UndoBlocked,
  ChangeAwaitingApproval,
  type RefineUndoDeps,
} from "@/services/agents/refine-undo";
import { DoubleBuildInFlight } from "@/services/agents/start-product-build";
import type { ConductorNode } from "@/services/agents/conductor";
import type { SiteRow, SiteSandbox } from "@/services/sites/contract";
import { siteRow, T1 } from "@/services/sites/__tests__/fake-site-store";

const SA = "aaaaaaaa-0000-4000-8000-000000000001";
const SB = "bbbbbbbb-0000-4000-8000-000000000002";
const RA = "run-root-a";
const RB = "run-root-b";

function sites(over: Partial<SiteRow> = {}): SiteRow[] {
  return [
    siteRow({ id: SA, label: "alpha", root_conductor_run_id: RA, status: "live", live_sha: "1111111", live_deploy_id: "d1", ...over }),
    siteRow({ id: SB, label: "beta", root_conductor_run_id: RB, status: "live", live_sha: "2222222", live_deploy_id: "d2" }),
  ];
}

function refineDeps(rows: SiteRow[], over: Partial<RefineProductDeps> = {}) {
  const d = {
    loadProvisionedTarget: vi.fn().mockResolvedValue({ github_full_name: "Praxis-build/singleton", default_branch: "main" }),
    loadPriorRefines: vi.fn().mockResolvedValue([]),
    verifyConductorRunOwnership: vi.fn().mockResolvedValue(true),
    loadConductorRunKind: vi.fn().mockResolvedValue("build_app"),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_refine_1"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    loadRepoHeadSha: vi.fn().mockResolvedValue("pre0sha"),
    resolveRefineDirectMergeEnabled: vi.fn().mockResolvedValue(true),
    isFleetHalted: vi.fn().mockResolvedValue(false),
    loadAppPolicy: vi.fn().mockResolvedValue({ protected_globs: [], freeze: false, preview: "branch_preview" }),
    loadBuildRetired: vi.fn().mockResolvedValue(false),
    loadSiteForRun: vi.fn(async (t: string, run: string) => rows.find((s) => s.tenant_id === t && s.root_conductor_run_id === run) ?? null),
    markSiteEdited: vi.fn().mockResolvedValue(undefined),
    wakeSite: vi.fn().mockResolvedValue({}),
    ...(over as object),
  };
  return d;
}

function graphOf(d: ReturnType<typeof refineDeps>): ConductorNode[] {
  const call = d.updateConductorRunStatus.mock.calls.find((c) => (c[0] as { goal_graph?: unknown }).goal_graph);
  return (call![0] as { goal_graph: ConductorNode[] }).goal_graph;
}

const MSG = "make the header sticky on every page";

describe("refineProduct on new-flow sites", () => {
  it("refining site A targets A's repo only, stamps site_id, never the singleton", async () => {
    const d = refineDeps(sites());
    const r = await refineProduct({ tenant_id: T1, message: MSG, conductor_run_id: RA }, d as unknown as RefineProductDeps);
    expect(r.site_id).toBe(SA);
    expect(r.target.github_full_name).toBe("Praxis-build/alpha");
    expect(d.loadProvisionedTarget).not.toHaveBeenCalled();
    expect(d.loadBuildRetired).not.toHaveBeenCalled();
    const g = graphOf(d);
    expect(g.map((n) => n.payload.stage)).toEqual(["build", "deploy"]);
    for (const n of g) {
      expect(n.payload.site_id).toBe(SA);
      expect((n.payload.target as { github_full_name: string }).github_full_name).toBe("Praxis-build/alpha");
    }
    expect(JSON.stringify(g)).not.toContain("Praxis-build/beta");
    expect(d.markSiteEdited).toHaveBeenCalledWith(T1, SA);
  });

  it("site B's refine is B's; an older site session is never 'superseded'", async () => {
    const d = refineDeps(sites());
    const r = await refineProduct({ tenant_id: T1, message: MSG, conductor_run_id: RB }, d as unknown as RefineProductDeps);
    expect(r.target.github_full_name).toBe("Praxis-build/beta");
    expect(graphOf(d)[0].payload.site_id).toBe(SB);
  });

  it("live edit and the gate-evidence path are off for sites (our gate is the site gate)", async () => {
    const d = refineDeps(sites(), { resolveRefineDirectMergeEnabled: vi.fn().mockResolvedValue(false) });
    await refineProduct({ tenant_id: T1, message: MSG, conductor_run_id: RA }, d as unknown as RefineProductDeps);
    const g = graphOf(d);
    expect(g).toHaveLength(1);
    expect(g[0].payload.live_edit_branch).toBeUndefined();
    expect(g[0].payload.refine_gate).toBeUndefined();
  });

  it("a paused site is woken first", async () => {
    const d = refineDeps(sites({ status: "paused" }));
    await refineProduct({ tenant_id: T1, message: MSG, conductor_run_id: RA }, d as unknown as RefineProductDeps);
    expect(d.wakeSite).toHaveBeenCalledWith("alpha.zaviagent.com");
  });

  it("a failed or deleted site cannot be refined", async () => {
    const d = refineDeps(sites({ status: "deleted" }));
    await expect(
      refineProduct({ tenant_id: T1, message: MSG, conductor_run_id: RA }, d as unknown as RefineProductDeps),
    ).rejects.toBeInstanceOf(SiteUnavailable);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });

  it("a site that fell back to the old flow is an old-flow app: frozen, never edited", async () => {
    const d = refineDeps(sites({ status: "fell_back_old" }));
    await expect(
      refineProduct({ tenant_id: T1, message: MSG, conductor_run_id: RA }, d as unknown as RefineProductDeps),
    ).rejects.toBeInstanceOf(OldSiteFrozen);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });

  it("a site of another tenant is never used (its run reads as an old-flow session: frozen)", async () => {
    const d = refineDeps([siteRow({ id: SA, tenant_id: "22222222-2222-4222-8222-222222222222", root_conductor_run_id: RA })], {
      loadSiteForRun: vi.fn().mockResolvedValue(siteRow({ id: SA, tenant_id: "22222222-2222-4222-8222-222222222222", root_conductor_run_id: RA })),
    });
    await expect(
      refineProduct({ tenant_id: T1, message: MSG, conductor_run_id: RA }, d as unknown as RefineProductDeps),
    ).rejects.toBeInstanceOf(OldSiteFrozen);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });
});

const REVERTED = "abc1234def5678901234567890123456789abcde";
const NEW_SHA = "fff1234def5678901234567890123456789abcde";

function undoDeps(rows: SiteRow[], over: Partial<RefineUndoDeps> = {}) {
  const refineA = { conductor_run_id: "ref-a", child_run_id: "ar", output_text: null, parsed: { commit_sha: REVERTED } };
  const runSite: Record<string, string> = { "ref-a": SA, [RA]: SA, "ref-b": SB, [RB]: SB };
  const republish = {
    reserve: vi.fn().mockResolvedValue("cr_republish"),
    stage: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const d = {
    loadLatestShippedRefine: vi.fn().mockResolvedValue({ ...refineA }),
    loadProvisionedTarget: vi.fn().mockResolvedValue({ github_full_name: "Praxis-build/singleton", default_branch: "main" }),
    assertProvisionedRepo: {
      loadRepoResource: vi.fn().mockResolvedValue(null),
      loadSiteByRepo: vi.fn(async (t: string, name: string) => rows.find((s) => s.tenant_id === t && s.github_full_name === name) ?? null),
    },
    resolveInstallation: vi.fn().mockResolvedValue(-1),
    readBranchHeadSha: vi.fn().mockResolvedValue(null),
    listRecentCommits: vi.fn().mockResolvedValue([]),
    revertOnMain: vi.fn().mockResolvedValue({ reverted: true, branch: "main", new_commit_sha: NEW_SHA }),
    insertUndoRun: vi.fn().mockResolvedValue("cr_undo"),
    requestStaticPublish: vi.fn().mockResolvedValue(undefined),
    loadSiteOfRun: vi.fn(async (t: string, run: string) => rows.find((s) => s.tenant_id === t && s.id === runSite[run]) ?? null),
    loadLatestShippedRefineForSite: vi.fn(async (_t: string, site_id: string): ReturnType<NonNullable<RefineUndoDeps["loadLatestShippedRefineForSite"]>> => (site_id === SA ? { ...refineA } : null)),
    siteRepublish: republish,
    readBranchRefSha: vi.fn().mockResolvedValue(REVERTED),
    claimUndoRun: vi.fn().mockResolvedValue("cr_undo_claim"),
    settleUndoRun: vi.fn().mockResolvedValue(undefined),
    releaseUndoRun: vi.fn().mockResolvedValue(undefined),
    ...(over as object),
  };
  return { d, republish };
}

describe("refineUndo on new-flow sites", () => {
  it("undo of site A reverts A's repo and republishes A at the revert commit", async () => {
    const { d, republish } = undoDeps(sites());
    const r = await refineUndo({ tenant_id: T1, conductor_run_id: "ref-a" }, d as unknown as RefineUndoDeps);
    expect(r).toMatchObject({ reverted_commit_sha: REVERTED, new_commit_sha: NEW_SHA });
    expect(d.revertOnMain).toHaveBeenCalledWith(expect.objectContaining({ owner: "Praxis-build", repo: "alpha", commit_sha: REVERTED }));
    expect(republish.reserve.mock.invocationCallOrder[0]).toBeLessThan(d.revertOnMain.mock.invocationCallOrder[0]);
    expect(republish.start).toHaveBeenCalledWith(expect.objectContaining({ conductor_run_id: "cr_republish", sha: NEW_SHA }));
    expect(republish.start.mock.calls[0][0].site.id).toBe(SA);
    expect(d.claimUndoRun).toHaveBeenCalledWith(expect.objectContaining({ site_id: SA, parent_conductor_run_id: "ref-a" }));
    expect(d.settleUndoRun).toHaveBeenCalledWith(expect.objectContaining({ site_id: SA, id: "cr_undo_claim", new_commit_sha: NEW_SHA }));
    expect(r).toMatchObject({ undo_conductor_run_id: "cr_undo_claim", republished: true, history_recorded: true, draft_reset: true });
    expect(d.loadProvisionedTarget).not.toHaveBeenCalled();
    expect(d.requestStaticPublish).not.toHaveBeenCalled();
    expect(JSON.stringify(d.revertOnMain.mock.calls)).not.toContain("beta");
  });

  it("the unpinned undo of a site's latest refine stays on that site", async () => {
    const { d } = undoDeps(sites());
    await refineUndo({ tenant_id: T1 }, d as unknown as RefineUndoDeps);
    expect(d.revertOnMain).toHaveBeenCalledWith(expect.objectContaining({ repo: "alpha" }));
  });

  it("site B with nothing shipped is not undoable, and site A is untouched", async () => {
    const { d } = undoDeps(sites());
    await expect(refineUndo({ tenant_id: T1, conductor_run_id: "ref-b" }, d as unknown as RefineUndoDeps)).rejects.toBeInstanceOf(NoUndoableRefine);
    expect(d.revertOnMain).not.toHaveBeenCalled();
  });

  it("a merged code change awaiting schema review cannot be undone as shipped", async () => {
    const { d, republish } = undoDeps(sites());
    d.loadLatestShippedRefineForSite.mockResolvedValueOnce({
      conductor_run_id: "ref-a", child_run_id: "ar-a", output_text: null,
      parsed: { merged: true, commit_sha: REVERTED } as unknown as { commit_sha: string }, awaiting_review: true,
    } as never);
    await expect(refineUndo({ tenant_id: T1, conductor_run_id: "ref-a" }, d as unknown as RefineUndoDeps)).rejects.toBeInstanceOf(ChangeAwaitingApproval);
    expect(d.revertOnMain).not.toHaveBeenCalled();
    expect(republish.reserve).not.toHaveBeenCalled();
  });

  it("a busy slot refuses before the revert", async () => {
    const { d, republish } = undoDeps(sites());
    republish.reserve.mockRejectedValueOnce(new Error("build in flight"));
    await expect(refineUndo({ tenant_id: T1, conductor_run_id: "ref-a" }, d as unknown as RefineUndoDeps)).rejects.toThrow("build in flight");
    expect(d.revertOnMain).not.toHaveBeenCalled();
  });

  it("a failed revert releases the republish slot", async () => {
    const { d, republish } = undoDeps(sites());
    d.revertOnMain.mockRejectedValueOnce(new Error("github 500"));
    await expect(refineUndo({ tenant_id: T1, conductor_run_id: "ref-a" }, d as unknown as RefineUndoDeps)).rejects.toThrow("github 500");
    expect(republish.release).toHaveBeenCalledWith({ tenant_id: T1, conductor_run_id: "cr_republish" });
    expect(republish.start).not.toHaveBeenCalled();
  });

  it("without the site republisher it refuses before any revert", async () => {
    const { d } = undoDeps(sites(), { siteRepublish: undefined });
    await expect(refineUndo({ tenant_id: T1, conductor_run_id: "ref-a" }, d as unknown as RefineUndoDeps)).rejects.toBeInstanceOf(NotProvisioned);
    expect(d.revertOnMain).not.toHaveBeenCalled();
  });

  it("version restore refuses a site run instead of using the singleton repo", async () => {
    const { d } = undoDeps(sites(), {
      loadShippedRefineById: vi.fn(),
      loadEarliestShippedRefine: vi.fn(),
      readCommitParentSha: vi.fn(),
      restoreOnMain: vi.fn(),
    });
    await expect(
      resolveVersionCommit({ tenant_id: T1, conductor_run_id: "ref-a", purpose: "restore" } as never, d as unknown as RefineUndoDeps),
    ).rejects.toBeInstanceOf(NotProvisioned);
    expect(d.loadProvisionedTarget).not.toHaveBeenCalled();
  });
});

describe("Home's undo (workspace_only): never a site's change", () => {
  it("refuses site A's (or site B's) pinned edit without touching any repo", async () => {
    for (const id of ["ref-a", "ref-b"]) {
      const { d, republish } = undoDeps(sites());
      await expect(
        refineUndo({ tenant_id: T1, conductor_run_id: id, workspace_only: true }, d as unknown as RefineUndoDeps),
      ).rejects.toBeInstanceOf(NoUndoableRefine);
      expect(d.revertOnMain).not.toHaveBeenCalled();
      expect(republish.reserve).not.toHaveBeenCalled();
      expect(d.loadProvisionedTarget).not.toHaveBeenCalled();
    }
  });

  it("an unpinned undo whose latest shipped edit is a site's is refused, not redirected to the site", async () => {
    const { d, republish } = undoDeps(sites());
    await expect(refineUndo({ tenant_id: T1, workspace_only: true }, d as unknown as RefineUndoDeps)).rejects.toBeInstanceOf(NoUndoableRefine);
    expect(d.revertOnMain).not.toHaveBeenCalled();
    expect(republish.reserve).not.toHaveBeenCalled();
  });

  it("the workspace app's own latest edit is refused: the old-flow app is frozen", async () => {
    const { d, republish } = undoDeps(sites(), {
      loadLatestShippedRefine: vi.fn().mockResolvedValue({ conductor_run_id: "ref-old", child_run_id: "ar", output_text: null, parsed: { commit_sha: REVERTED } }),
    });
    await expect(
      refineUndo({ tenant_id: T1, conductor_run_id: "ref-old", workspace_only: true }, d as unknown as RefineUndoDeps),
    ).rejects.toBeInstanceOf(OldSiteFrozen);
    expect(d.revertOnMain).not.toHaveBeenCalled();
    expect(republish.reserve).not.toHaveBeenCalled();
  });
});

describe("guarded site undo (parity item 1)", () => {
  const run = (d: unknown, id = "ref-a") => refineUndo({ tenant_id: T1, conductor_run_id: id }, d as RefineUndoDeps);
  const blockedReason = async (p: Promise<unknown>) => {
    const e = await p.then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(UndoBlocked);
    return (e as UndoBlocked).reason;
  };

  it("order: reserve slot, HEAD check, claim, revert with expected_head_sha, settle, republish", async () => {
    const { d, republish } = undoDeps(sites());
    await run(d);
    const order = [
      republish.reserve.mock.invocationCallOrder[0],
      d.readBranchRefSha.mock.invocationCallOrder[0],
      d.claimUndoRun.mock.invocationCallOrder[0],
      d.revertOnMain.mock.invocationCallOrder[0],
      d.settleUndoRun.mock.invocationCallOrder[0],
      republish.start.mock.invocationCallOrder[0],
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(d.readBranchRefSha).toHaveBeenCalledWith(expect.objectContaining({ owner: "Praxis-build", repo: "alpha", branch: "main" }));
    expect(d.revertOnMain).toHaveBeenCalledWith(expect.objectContaining({ expected_head_sha: REVERTED }));
    expect(d.insertUndoRun).not.toHaveBeenCalled();
  });

  it("a moved HEAD refuses as newer_change and releases the slot, with no claim and no revert", async () => {
    const { d, republish } = undoDeps(sites());
    d.readBranchRefSha.mockResolvedValue("9999999def5678901234567890123456789abcde");
    expect(await blockedReason(run(d))).toBe("newer_change");
    expect(d.claimUndoRun).not.toHaveBeenCalled();
    expect(d.revertOnMain).not.toHaveBeenCalled();
    expect(republish.release).toHaveBeenCalledWith({ tenant_id: T1, conductor_run_id: "cr_republish" });
  });

  it("an unreadable HEAD refuses and releases the slot", async () => {
    const { d, republish } = undoDeps(sites());
    d.readBranchRefSha.mockResolvedValue(null);
    expect(await blockedReason(run(d))).toBe("newer_change");
    expect(republish.release).toHaveBeenCalled();
  });

  it("a busy build (double_build) refuses as build_in_progress before anything else", async () => {
    const { d, republish } = undoDeps(sites());
    republish.reserve.mockRejectedValueOnce(new DoubleBuildInFlight(T1));
    expect(await blockedReason(run(d))).toBe("build_in_progress");
    expect(d.readBranchRefSha).not.toHaveBeenCalled();
    expect(d.claimUndoRun).not.toHaveBeenCalled();
    expect(republish.release).not.toHaveBeenCalled();
  });

  it("a concurrent undo (claim refused) releases the slot and never reverts", async () => {
    const { d, republish } = undoDeps(sites());
    d.claimUndoRun.mockRejectedValueOnce(new UndoBlocked("undo_in_progress", "already"));
    expect(await blockedReason(run(d))).toBe("undo_in_progress");
    expect(d.revertOnMain).not.toHaveBeenCalled();
    expect(republish.release).toHaveBeenCalledWith({ tenant_id: T1, conductor_run_id: "cr_republish" });
  });

  it("GitHub refusing the expected head releases BOTH the claim and the slot", async () => {
    const { d, republish } = undoDeps(sites());
    d.revertOnMain.mockRejectedValueOnce(Object.assign(new Error("moved"), { code: "revert_head_moved" }));
    expect(await blockedReason(run(d))).toBe("newer_change");
    expect(d.releaseUndoRun).toHaveBeenCalledWith({ tenant_id: T1, id: "cr_undo_claim" });
    expect(republish.release).toHaveBeenCalledWith({ tenant_id: T1, conductor_run_id: "cr_republish" });
    expect(d.settleUndoRun).not.toHaveBeenCalled();
    expect(republish.start).not.toHaveBeenCalled();
  });

  it("a claim-release failure after a failed revert still releases the slot and surfaces the revert error", async () => {
    const { d, republish } = undoDeps(sites());
    d.revertOnMain.mockRejectedValueOnce(new Error("github 500"));
    d.releaseUndoRun.mockRejectedValueOnce(new Error("db down"));
    await expect(run(d)).rejects.toThrow("github 500");
    expect(republish.release).toHaveBeenCalled();
  });

  it("a settle failure reports history_recorded:false and still republishes", async () => {
    const { d, republish } = undoDeps(sites());
    d.settleUndoRun.mockRejectedValueOnce(new Error("db down"));
    const r = await run(d);
    expect(r).toMatchObject({ history_recorded: false, republished: true, draft_reset: true });
    expect(republish.start).toHaveBeenCalled();
  });

  it("a republish that does not start is NOT dropped: the slot keeps its staged republish and it reports pending", async () => {
    const { d, republish } = undoDeps(sites());
    republish.start.mockRejectedValueOnce(new Error("db down"));
    const r = await run(d);
    expect(r).toMatchObject({ republished: false, republish_pending: true, history_recorded: true, new_commit_sha: NEW_SHA });
    expect(republish.release).not.toHaveBeenCalled();
    expect(republish.stage).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T1, conductor_run_id: "cr_republish" }));
  });

  it("a republish whose reserved run was ended under it is published through a FRESH run", async () => {
    const { d, republish } = undoDeps(sites());
    republish.reserve.mockResolvedValueOnce("cr_republish").mockResolvedValueOnce("cr_fresh");
    republish.start.mockRejectedValueOnce(Object.assign(new Error("gone"), { name: "SiteRepublishGone" }));
    const r = await run(d);
    expect(r).toMatchObject({ republished: true, republish_pending: false });
    expect(republish.stage).toHaveBeenLastCalledWith(expect.objectContaining({ conductor_run_id: "cr_fresh" }));
    expect(republish.start).toHaveBeenLastCalledWith(expect.objectContaining({ conductor_run_id: "cr_fresh", sha: NEW_SHA }));
  });

  it("gone AND no fresh slot (another build holds it): reported as not pending, never a false promise", async () => {
    const { d, republish } = undoDeps(sites());
    republish.reserve.mockResolvedValueOnce("cr_republish").mockRejectedValueOnce(new DoubleBuildInFlight(T1));
    republish.start.mockRejectedValueOnce(Object.assign(new Error("gone"), { name: "SiteRepublishGone" }));
    const r = await run(d);
    expect(r).toMatchObject({ republished: false, republish_pending: false });
  });

  it("gone, fresh run staged, its start fails: pending (the fresh staged run is resumed)", async () => {
    const { d, republish } = undoDeps(sites());
    republish.reserve.mockResolvedValueOnce("cr_republish").mockResolvedValueOnce("cr_fresh");
    republish.start
      .mockRejectedValueOnce(Object.assign(new Error("gone"), { name: "SiteRepublishGone" }))
      .mockRejectedValueOnce(new Error("db down"));
    const r = await run(d);
    expect(r).toMatchObject({ republished: false, republish_pending: true });
    expect(republish.release).not.toHaveBeenCalled();
  });

  it("the republish is staged BEFORE the revert; a stage failure frees the slot and never reverts", async () => {
    const { d, republish } = undoDeps(sites());
    await run(d);
    expect(republish.stage.mock.invocationCallOrder[0]).toBeLessThan(d.revertOnMain.mock.invocationCallOrder[0]);
    const t2 = undoDeps(sites());
    t2.republish.stage.mockRejectedValueOnce(new Error("db down"));
    await expect(run(t2.d)).rejects.toThrow("db down");
    expect(t2.republish.release).toHaveBeenCalledWith({ tenant_id: T1, conductor_run_id: "cr_republish" });
    expect(t2.d.revertOnMain).not.toHaveBeenCalled();
    expect(t2.d.claimUndoRun).not.toHaveBeenCalled();
  });

  it("without the claim deps it refuses before reserving or reverting", async () => {
    const { d, republish } = undoDeps(sites(), { claimUndoRun: undefined });
    await expect(run(d)).rejects.toBeInstanceOf(NotProvisioned);
    expect(republish.reserve).not.toHaveBeenCalled();
    expect(d.revertOnMain).not.toHaveBeenCalled();
  });

  it("site B's newer shipped edit does not change which commit site A's undo reverts", async () => {
    const { d } = undoDeps(sites(), {
      loadLatestShippedRefine: vi.fn().mockResolvedValue({ conductor_run_id: "ref-b", child_run_id: null, output_text: null, parsed: { commit_sha: "bbbbbbbdef5678901234567890123456789abcde" } }),
    });
    await run(d);
    expect(d.revertOnMain).toHaveBeenCalledWith(expect.objectContaining({ repo: "alpha", commit_sha: REVERTED }));
    expect(d.loadLatestShippedRefine).not.toHaveBeenCalled();
  });
});

describe("undo on a site that was never published (build_publish_on_request)", () => {
  const run = (d: unknown, id = "ref-a") => refineUndo({ tenant_id: T1, conductor_run_id: id }, d as RefineUndoDeps);
  const neverPublished = () => sites({ status: "building", live_sha: null, live_deploy_id: null, live_url: null });

  type SlotRow = { status: "provisioning" | "active" | "failed"; kind: "build_app" | "undo" };

  function slotModel() {
    const rows = new Map<string, SlotRow>();
    let seq = 0;
    const held = () => [...rows.values()].some((r) => r.kind === "build_app" && (r.status === "provisioning" || r.status === "active"));
    const republish = {
      stage: vi.fn().mockResolvedValue(undefined),
      reserve: vi.fn(async (_i: { tenant_id: string; site: SiteRow }) => {
        if (held()) throw new DoubleBuildInFlight(T1);
        const id = `slot-${++seq}`;
        rows.set(id, { status: "provisioning", kind: "build_app" });
        return id;
      }),
      start: vi.fn(async (i: { conductor_run_id: string }) => {
        rows.get(i.conductor_run_id)!.status = "active";
      }),
      release: vi.fn(async (i: { conductor_run_id: string }) => {
        rows.get(i.conductor_run_id)!.status = "failed";
      }),
    };
    const discardHeldSlot = vi.fn(async (i: { tenant_id: string; conductor_run_id: string }) => {
      const r = rows.get(i.conductor_run_id);
      if (r && r.status === "provisioning") rows.set(i.conductor_run_id, { status: "failed", kind: "undo" });
    });
    const visible = () => [...rows.values()].filter((r) => r.kind === "build_app");
    return { rows, republish, discardHeldSlot, held, visible };
  }

  function previewDeps(rows: SiteRow[], over: Partial<RefineUndoDeps> = {}) {
    const model = slotModel();
    const syncSitePreview = vi.fn(async (_p: { tenant_id: string; site: SiteRow; sha: string }): Promise<void> => undefined);
    const resolveBuildPublishOnRequest = vi.fn(async (_t: string) => true);
    const { d } = undoDeps(rows, {
      siteRepublish: model.republish,
      discardHeldSlot: model.discardHeldSlot,
      syncSitePreview,
      resolveBuildPublishOnRequest,
      hasActiveBuild: vi.fn().mockResolvedValue(false),
      ...over,
    });
    return { d, model, syncSitePreview, resolveBuildPublishOnRequest };
  }

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const revertStarted = async (d: { revertOnMain: { mock: { calls: unknown[] } } }) => {
    for (let i = 0; i < 50 && d.revertOnMain.mock.calls.length === 0; i++) await tick();
    expect(d.revertOnMain.mock.calls).toHaveLength(1);
  };
  const publishAsks = (model: ReturnType<typeof slotModel>, rows: SiteRow[]) => model.republish.reserve({ tenant_id: T1, site: rows[0] });

  it("setting on: reverts the edit, records it, starts no republish and leaves no build run behind", async () => {
    const { d, model, resolveBuildPublishOnRequest } = previewDeps(neverPublished());
    const r = await run(d);
    expect(d.revertOnMain).toHaveBeenCalledTimes(1);
    expect(d.revertOnMain).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "Praxis-build", repo: "alpha", commit_sha: REVERTED, expected_head_sha: REVERTED }),
    );
    expect(d.claimUndoRun).toHaveBeenCalledWith(expect.objectContaining({ site_id: SA, parent_conductor_run_id: "ref-a" }));
    expect(d.settleUndoRun).toHaveBeenCalledWith(expect.objectContaining({ site_id: SA, id: "cr_undo_claim", new_commit_sha: NEW_SHA }));
    expect(model.republish.start).not.toHaveBeenCalled();
    expect(model.republish.release).not.toHaveBeenCalled();
    expect(model.discardHeldSlot).toHaveBeenCalledWith({ tenant_id: T1, conductor_run_id: "slot-1" });
    expect(model.held()).toBe(false);
    expect(model.visible()).toEqual([]);
    expect(d.requestStaticPublish).not.toHaveBeenCalled();
    expect(r).toEqual({
      undo_conductor_run_id: "cr_undo_claim",
      reverted_conductor_run_id: "ref-a",
      reverted_commit_sha: REVERTED,
      new_commit_sha: NEW_SHA,
      branch: "main",
      republished: false,
      republish_pending: false,
      history_recorded: true,
      draft_reset: true,
      preview_only: true,
    });
    expect(resolveBuildPublishOnRequest).toHaveBeenCalledWith(T1);
  });

  it("the preview is moved to the revert commit after the revert, while the slot is still held", async () => {
    const { d, model, syncSitePreview } = previewDeps(neverPublished());
    const heldDuringSync: boolean[] = [];
    syncSitePreview.mockImplementation(async () => {
      heldDuringSync.push(model.held());
    });
    await run(d);
    expect(syncSitePreview).toHaveBeenCalledTimes(1);
    const arg = syncSitePreview.mock.calls[0][0];
    expect(arg).toMatchObject({ tenant_id: T1, sha: NEW_SHA });
    expect(arg.site.id).toBe(SA);
    expect(d.revertOnMain.mock.invocationCallOrder[0]).toBeLessThan(syncSitePreview.mock.invocationCallOrder[0]);
    expect(heldDuringSync).toEqual([true]);
    expect(model.held()).toBe(false);
  });

  it("a preview that cannot be moved marks the saved snapshot stale, so Build never shows the undone version as current", async () => {
    const markPreviewStale = vi.fn(async (_t: string, _s: string) => undefined);
    const { d, syncSitePreview } = previewDeps(neverPublished(), { markPreviewStale });
    syncSitePreview.mockRejectedValueOnce(new Error("sandbox git failed"));
    const r = await run(d);
    expect(r).toMatchObject({ preview_stale: true });
    expect(markPreviewStale).toHaveBeenCalledTimes(1);
    expect(markPreviewStale.mock.calls[0]![1]).toBe(syncSitePreview.mock.calls[0]![0].site.id);
    expect(d.revertOnMain.mock.invocationCallOrder[0]).toBeLessThan(markPreviewStale.mock.invocationCallOrder[0]!);
  });

  it("a moved preview does not mark it stale here (the sync itself marks it and asks for a new capture)", async () => {
    const markPreviewStale = vi.fn(async (_t: string, _s: string) => undefined);
    const { d } = previewDeps(neverPublished(), { markPreviewStale });
    await run(d);
    expect(markPreviewStale).not.toHaveBeenCalled();
  });

  it("a failed stale mark never fails the undo", async () => {
    const markPreviewStale = vi.fn(async () => {
      throw new Error("db down");
    });
    const { d, syncSitePreview } = previewDeps(neverPublished(), { markPreviewStale });
    syncSitePreview.mockRejectedValueOnce(new Error("sandbox git failed"));
    await expect(run(d)).resolves.toMatchObject({ preview_stale: true, new_commit_sha: NEW_SHA });
  });

  it("a preview that cannot be moved keeps the revert and says the preview is stale", async () => {
    const { d, model, syncSitePreview } = previewDeps(neverPublished());
    syncSitePreview.mockRejectedValueOnce(new Error("sandbox git failed"));
    const r = await run(d);
    expect(r).toMatchObject({ new_commit_sha: NEW_SHA, republished: false, history_recorded: true, preview_only: true, preview_stale: true });
    expect(d.revertOnMain).toHaveBeenCalledTimes(1);
    expect(d.settleUndoRun).toHaveBeenCalledTimes(1);
    expect(d.releaseUndoRun).not.toHaveBeenCalled();
    expect(model.held()).toBe(false);
    expect(model.visible()).toEqual([]);
  });

  it("with no preview sync wired the undo still succeeds and reports the preview as stale", async () => {
    const { d } = previewDeps(neverPublished(), { syncSitePreview: undefined });
    expect(await run(d)).toMatchObject({ preview_only: true, preview_stale: true, new_commit_sha: NEW_SHA });
  });

  it("while the revert is in flight a publish cannot take the slot; once the undo finishes it can", async () => {
    const rows = neverPublished();
    const { d, model } = previewDeps(rows);
    const gate = deferred<{ reverted: true; branch: string; new_commit_sha: string }>();
    d.revertOnMain.mockImplementationOnce(() => gate.promise);
    const undo = run(d);
    await revertStarted(d);
    await expect(publishAsks(model, rows)).rejects.toBeInstanceOf(DoubleBuildInFlight);
    expect(model.republish.start).not.toHaveBeenCalled();
    gate.resolve({ reverted: true, branch: "main", new_commit_sha: NEW_SHA });
    expect(await undo).toMatchObject({ preview_only: true, new_commit_sha: NEW_SHA });
    await expect(publishAsks(model, rows)).resolves.toBe("slot-2");
  });

  it("a second undo of the same change during the first is refused as busy and the commit is reverted once", async () => {
    const { d, model } = previewDeps(neverPublished());
    const gate = deferred<{ reverted: true; branch: string; new_commit_sha: string }>();
    d.revertOnMain.mockImplementationOnce(() => gate.promise);
    const first = run(d);
    await revertStarted(d);
    const second = await run(d).then(() => null, (err: unknown) => err);
    expect(second).toBeInstanceOf(UndoBlocked);
    expect((second as UndoBlocked).reason).toBe("build_in_progress");
    gate.resolve({ reverted: true, branch: "main", new_commit_sha: NEW_SHA });
    await first;
    expect(d.revertOnMain).toHaveBeenCalledTimes(1);
    expect(d.claimUndoRun).toHaveBeenCalledTimes(1);
    expect(model.held()).toBe(false);
    expect(model.visible()).toEqual([]);
  });

  it("a build, edit or publish already running refuses before the HEAD read, the claim and the revert", async () => {
    const rows = neverPublished();
    const { d, model } = previewDeps(rows);
    await publishAsks(model, rows);
    const e = await run(d).then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(UndoBlocked);
    expect((e as UndoBlocked).reason).toBe("build_in_progress");
    expect(d.readBranchRefSha).not.toHaveBeenCalled();
    expect(d.claimUndoRun).not.toHaveBeenCalled();
    expect(d.revertOnMain).not.toHaveBeenCalled();
    expect(model.discardHeldSlot).not.toHaveBeenCalled();
  });

  it("the slot is given back with nothing left behind when the revert fails, the HEAD read throws, HEAD moved or the claim is refused", async () => {
    const cases: Array<[string, (d: ReturnType<typeof previewDeps>["d"]) => void]> = [
      ["revert fails", (d) => d.revertOnMain.mockRejectedValueOnce(new Error("github 500"))],
      ["revert head moved", (d) => d.revertOnMain.mockRejectedValueOnce(Object.assign(new Error("moved"), { code: "revert_head_moved" }))],
      ["head read throws", (d) => d.readBranchRefSha.mockRejectedValueOnce(new Error("github down"))],
      ["head moved", (d) => d.readBranchRefSha.mockResolvedValueOnce("9999999def5678901234567890123456789abcde")],
      ["claim refused", (d) => d.claimUndoRun.mockRejectedValueOnce(new UndoBlocked("undo_in_progress", "already"))],
    ];
    for (const [name, arrange] of cases) {
      const rows = neverPublished();
      const { d, model, syncSitePreview } = previewDeps(rows);
      arrange(d);
      await expect(run(d), name).rejects.toBeInstanceOf(Error);
      expect(model.held(), name).toBe(false);
      expect(model.visible(), name).toEqual([]);
      expect(model.discardHeldSlot, name).toHaveBeenCalledTimes(1);
      expect(model.republish.start, name).not.toHaveBeenCalled();
      expect(syncSitePreview, name).not.toHaveBeenCalled();
      expect(d.settleUndoRun, name).not.toHaveBeenCalled();
      await expect(publishAsks(model, rows), name).resolves.toBe("slot-2");
    }
  });

  it("a failed revert also releases the undo claim", async () => {
    const { d } = previewDeps(neverPublished());
    d.revertOnMain.mockRejectedValueOnce(new Error("github 500"));
    await expect(run(d)).rejects.toThrow("github 500");
    expect(d.releaseUndoRun).toHaveBeenCalledWith({ tenant_id: T1, id: "cr_undo_claim" });
  });

  it("if the held slot cannot be discarded it is released instead, so the workspace is never left locked", async () => {
    const { d, model } = previewDeps(neverPublished());
    model.discardHeldSlot.mockRejectedValueOnce(new Error("db down"));
    expect(await run(d)).toMatchObject({ preview_only: true, new_commit_sha: NEW_SHA });
    expect(model.republish.release).toHaveBeenCalledWith({ tenant_id: T1, conductor_run_id: "slot-1" });
    expect(model.held()).toBe(false);
  });

  it("setting on, site already live: the undo also waits in the preview (always click Publish) and its claim says so", async () => {
    const { d, model, syncSitePreview } = previewDeps(sites());
    const r = await run(d);
    expect(d.revertOnMain).toHaveBeenCalledTimes(1);
    expect(model.republish.start).not.toHaveBeenCalled();
    expect(r).toMatchObject({ republished: false, preview_only: true, new_commit_sha: NEW_SHA });
    expect(syncSitePreview).toHaveBeenCalledWith(expect.objectContaining({ sha: NEW_SHA }));
    expect(d.claimUndoRun).toHaveBeenCalledWith(expect.objectContaining({ preview_only: true }));
    expect(model.held()).toBe(false);
  });

  it("a site published once and now paused or building again also waits in the preview", async () => {
    for (const status of ["paused", "building"] as const) {
      const { d, model } = previewDeps(sites({ status }));
      expect(await run(d)).toMatchObject({ republished: false, preview_only: true });
      expect(model.republish.start).not.toHaveBeenCalled();
    }
  });

  it("setting off, site already live: undo republishes at the revert commit", async () => {
    const { d, model, syncSitePreview } = previewDeps(sites(), { resolveBuildPublishOnRequest: vi.fn().mockResolvedValue(false) });
    const r = await run(d);
    expect(model.republish.start).toHaveBeenCalledWith(expect.objectContaining({ conductor_run_id: "slot-1", sha: NEW_SHA }));
    expect(r).toMatchObject({ republished: true, history_recorded: true });
    expect(r).not.toHaveProperty("preview_only");
    expect(syncSitePreview).not.toHaveBeenCalled();
    expect(d.claimUndoRun).toHaveBeenCalledWith(expect.not.objectContaining({ preview_only: true }));
  });

  it("setting off: a never-published site's undo republishes as before", async () => {
    const { d, model, syncSitePreview } = previewDeps(neverPublished(), { resolveBuildPublishOnRequest: vi.fn().mockResolvedValue(false) });
    const r = await run(d);
    expect(model.republish.start).toHaveBeenCalledWith(expect.objectContaining({ conductor_run_id: "slot-1", sha: NEW_SHA }));
    expect(r).toMatchObject({ republished: true });
    expect(r).not.toHaveProperty("preview_only");
    expect(syncSitePreview).not.toHaveBeenCalled();
  });

  it("deps that do not wire the setting keep republishing", async () => {
    const { d, republish } = undoDeps(neverPublished());
    expect(await run(d)).toMatchObject({ republished: true });
    expect(republish.start).toHaveBeenCalledTimes(1);
  });

  it("a setting read that throws answers the default (on): the edit is reverted and nothing is published", async () => {
    const { d, model } = previewDeps(neverPublished(), { resolveBuildPublishOnRequest: vi.fn().mockRejectedValue(new Error("settings down")) });
    const r = await run(d);
    expect(d.revertOnMain).toHaveBeenCalledTimes(1);
    expect(model.republish.start).not.toHaveBeenCalled();
    expect(r).toMatchObject({ republished: false, preview_only: true });
  });
});

describe("syncSitePreviewToCommit: the site sandbox follows the revert", () => {
  const site = () => sites({ status: "building", live_sha: null, live_deploy_id: null })[0];
  const TOKEN = "ghp_exampleProvisionToken0123456789";

  function sandboxAt(answer: { exitCode?: number; head?: string; stderr?: string } = {}) {
    const calls: Array<{ cmd: string; opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; redact?: string[] } }> = [];
    const sandbox = {
      run: vi.fn(async (cmd: string, opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; redact?: string[] } = {}) => {
        calls.push({ cmd, opts });
        return { exitCode: answer.exitCode ?? 0, stdout: `__head=${answer.head ?? NEW_SHA}\n`, stderr: answer.stderr ?? "" };
      }),
      readFile: vi.fn(),
      listFiles: vi.fn(),
    };
    return { sandbox, calls };
  }

  function syncDeps(sandbox: unknown, token: string | null = TOKEN) {
    return {
      sandboxFor: vi.fn(async (_t: string, _s: string) => sandbox as SiteSandbox | null),
      fetchToken: vi.fn(() => token),
      kickPreview: vi.fn((_t: string, _r: string) => undefined),
      previewChanged: vi.fn(async (_t: string, _s: string) => undefined),
    };
  }

  it("an undo that moved the preview marks the site changed, so the saved snapshot of the undone version is never shown", async () => {
    const { sandbox } = sandboxAt();
    const deps = syncDeps(sandbox);
    await syncSitePreviewToCommit({ tenant_id: T1, site: site(), sha: NEW_SHA }, deps);
    expect(deps.previewChanged).toHaveBeenCalledWith(T1, SA);
    const failed = syncDeps(sandboxAt({ exitCode: 128, stderr: "fatal" }).sandbox);
    await expect(syncSitePreviewToCommit({ tenant_id: T1, site: site(), sha: NEW_SHA }, failed)).rejects.toThrow();
    expect(failed.previewChanged).not.toHaveBeenCalled();
  });

  it("fetches the commit into the site's own sandbox, hard-resets the tree to it, verifies HEAD, then makes sure the preview is up", async () => {
    const { sandbox, calls } = sandboxAt();
    const deps = syncDeps(sandbox);
    await syncSitePreviewToCommit({ tenant_id: T1, site: site(), sha: NEW_SHA }, deps);
    expect(deps.sandboxFor).toHaveBeenCalledWith(T1, SA);
    expect(calls).toHaveLength(1);
    const { cmd, opts } = calls[0];
    expect(cmd).toContain(`git fetch --quiet --no-tags https://github.com/Praxis-build/alpha.git ${NEW_SHA}`);
    expect(cmd).toContain(`git checkout -q -f -B main ${NEW_SHA}`);
    expect(cmd).toContain(`git reset -q --hard ${NEW_SHA}`);
    expect(cmd).toContain("git clean -fdq");
    expect(cmd.indexOf("git fetch")).toBeLessThan(cmd.indexOf("git checkout"));
    expect(opts.cwd).toBe("/home/user/repo");
    expect(cmd).not.toContain(TOKEN);
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    expect(cmd).not.toContain(basic);
    expect(opts.env).toMatchObject({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` });
    expect(opts.redact).toEqual(expect.arrayContaining([TOKEN, basic]));
    expect(deps.kickPreview).toHaveBeenCalledWith(T1, "Praxis-build/alpha");
    expect(sandbox.run.mock.invocationCallOrder[0]).toBeLessThan(deps.kickPreview.mock.invocationCallOrder[0]);
  });

  it("a site with no sandbox has no preview to refresh: nothing runs and nothing fails, but its snapshot is marked stale", async () => {
    const deps = syncDeps(null);
    await expect(syncSitePreviewToCommit({ tenant_id: T1, site: site(), sha: NEW_SHA }, deps)).resolves.toBeUndefined();
    expect(deps.kickPreview).not.toHaveBeenCalled();
    expect(deps.previewChanged).toHaveBeenCalledWith(T1, SA);
  });

  it("a git failure, or a tree that did not land on the commit, throws and never restarts the preview", async () => {
    for (const answer of [{ exitCode: 128, stderr: "fatal: could not read from remote" }, { head: REVERTED }, { head: "" }]) {
      const { sandbox } = sandboxAt(answer);
      const deps = syncDeps(sandbox);
      await expect(syncSitePreviewToCommit({ tenant_id: T1, site: site(), sha: NEW_SHA }, deps)).rejects.toThrow(/site preview sync/);
      expect(deps.kickPreview).not.toHaveBeenCalled();
    }
  });

  it("refuses a commit or repo that is not well formed before touching any sandbox", async () => {
    const { sandbox } = sandboxAt();
    const deps = syncDeps(sandbox);
    await expect(syncSitePreviewToCommit({ tenant_id: T1, site: site(), sha: "main; rm -rf /" }, deps)).rejects.toThrow(/invalid/);
    await expect(
      syncSitePreviewToCommit({ tenant_id: T1, site: { ...site(), github_full_name: "Praxis-build/alpha.git && curl evil" }, sha: NEW_SHA }, deps),
    ).rejects.toThrow(/invalid/);
    expect(deps.sandboxFor).not.toHaveBeenCalled();
    expect(sandbox.run).not.toHaveBeenCalled();
  });

  it("with no token it still fetches, with no credential header", async () => {
    const { sandbox, calls } = sandboxAt();
    await syncSitePreviewToCommit({ tenant_id: T1, site: site(), sha: NEW_SHA }, syncDeps(sandbox, null));
    expect(calls[0].opts.env).toEqual({ GIT_TERMINAL_PROMPT: "0" });
    expect(calls[0].opts.redact).toEqual([]);
  });
});

describe("version restore on a site that fell back to the old flow (S5 F4)", () => {
  it("resolves the old-flow repo instead of refusing it as a site", async () => {
    const { d } = undoDeps(sites({ status: "fell_back_old" }), {
      loadShippedRefineById: vi.fn().mockResolvedValue(null),
      loadEarliestShippedRefine: vi.fn().mockResolvedValue(null),
      readCommitParentSha: vi.fn(),
      restoreOnMain: vi.fn(),
    });
    const err = await resolveVersionCommit({ tenant_id: T1, conductor_run_id: "ref-a", purpose: "restore" } as never, d as unknown as RefineUndoDeps).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(String(err?.message ?? "")).not.toMatch(/not available for this site/);
    expect(d.loadSiteOfRun).toHaveBeenCalledWith(T1, "ref-a");
    expect(d.loadProvisionedTarget).toHaveBeenCalledWith(T1);
  });
});

describe("site republisher", () => {
  const repDeps = () => ({
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_x"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(5),
    requestTick: vi.fn().mockResolvedValue(true),
    stageReservedGraph: vi.fn().mockResolvedValue(undefined),
    activateReserved: vi.fn().mockResolvedValue("activated"),
    sleep: vi.fn(async () => undefined),
  });

  it("stage writes the UNPINNED republish node on the reserved run (publish main's HEAD)", async () => {
    const site = sites()[0];
    const deps = repDeps();
    await createSiteRepublisher(deps).stage({ tenant_id: T1, conductor_run_id: "cr_x", site });
    const g = deps.stageReservedGraph.mock.calls[0][0].goal_graph as ConductorNode[];
    expect(deps.stageReservedGraph.mock.calls[0][0].conductor_run_id).toBe("cr_x");
    expect(g[0].payload).toMatchObject({ stage: "deploy", republish: true, site_id: SA, refine_mode: true });
    expect(g[0].payload).not.toHaveProperty("site_sha");
  });

  it("start retries the activation, counts a run the sweep already resumed as started, and a failed tick is not a failure", async () => {
    const site = sites()[0];
    const deps = repDeps();
    deps.activateReserved.mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce("already_active");
    deps.requestTick.mockRejectedValueOnce(new Error("inngest down"));
    await createSiteRepublisher(deps).start({ tenant_id: T1, conductor_run_id: "cr_x", site, sha: NEW_SHA });
    expect(deps.activateReserved).toHaveBeenCalledTimes(2);
    const d2 = repDeps();
    d2.activateReserved.mockRejectedValue(new Error("db down"));
    await expect(createSiteRepublisher(d2).start({ tenant_id: T1, conductor_run_id: "cr_x", site, sha: NEW_SHA })).rejects.toThrow("db down");
    expect(d2.activateReserved).toHaveBeenCalledTimes(3);
    const d3 = repDeps();
    d3.activateReserved.mockResolvedValue("gone");
    await expect(createSiteRepublisher(d3).start({ tenant_id: T1, conductor_run_id: "cr_x", site, sha: NEW_SHA })).rejects.toMatchObject({ name: "SiteRepublishGone" });
  });

  it("release fails the run AND drops the staged node (a republish that never ran is not an edit)", async () => {
    const deps = repDeps();
    await createSiteRepublisher(deps).release({ tenant_id: T1, conductor_run_id: "cr_x" });
    expect(deps.updateConductorRunStatus).toHaveBeenCalledWith({ conductor_run_id: "cr_x", status: "failed", goal_graph: [] });
  });

  it("reserves a refine slot, then writes a single site deploy node and ticks", async () => {
    const site = sites()[0];
    const deps = repDeps();
    const rp = createSiteRepublisher(deps);
    expect(await rp.reserve({ tenant_id: T1, site })).toBe("cr_x");
    expect(deps.tryAcquireBuildSlot.mock.calls[0][0]).toMatchObject({ tenant_id: T1, is_refine: true, site_id: site.id });
    await rp.start({ tenant_id: T1, conductor_run_id: "cr_x", site, sha: NEW_SHA });
    const g = deps.activateReserved.mock.calls[0][0].goal_graph as ConductorNode[];
    expect(g).toHaveLength(1);
    expect(g[0].payload).toMatchObject({ stage: "deploy", site_id: SA, site_sha: NEW_SHA, refine_mode: true, parent_conductor_run_id: RA });
    expect(deps.requestTick).toHaveBeenCalledWith("cr_x");
    await expect(rp.start({ tenant_id: T1, conductor_run_id: "cr_x", site, sha: "main;rm" })).rejects.toThrow();
    expect(siteRepublishGraph(site, NEW_SHA)[0].target_agent_slug).toBe("");
  });
});

describe("the durable site lease guards edits and undo against a preview restart", () => {
  const restartingOn = (site: string) => vi.fn(async (_t: string, id: string) =>
    id === site ? ({ held: "restart" } as const) : { release: vi.fn(async () => undefined) });

  it("a refine of that site is refused before any slot or row, and another site still refines", async () => {
    const claim = restartingOn(SA);
    const d = refineDeps(sites(), { claimSiteEditLease: claim });
    await expect(refineProduct({ tenant_id: T1, message: MSG, conductor_run_id: RA }, d as unknown as RefineProductDeps)).rejects.toBeInstanceOf(
      SitePreviewRestarting,
    );
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    expect(d.updateConductorRunStatus).not.toHaveBeenCalled();
    await refineProduct({ tenant_id: T1, message: MSG, conductor_run_id: RB }, d as unknown as RefineProductDeps);
    expect(d.tryAcquireBuildSlot).toHaveBeenCalledTimes(1);
  });

  it("an edit holds the lease until its run row is active, then gives it back (also when the acquisition fails)", async () => {
    const release = vi.fn(async () => undefined);
    const d = refineDeps(sites(), { claimSiteEditLease: vi.fn(async () => ({ release })) });
    await refineProduct({ tenant_id: T1, message: MSG, conductor_run_id: RA }, d as unknown as RefineProductDeps);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.invocationCallOrder[0]).toBeGreaterThan(d.updateConductorRunStatus.mock.invocationCallOrder[0]);
    const r2 = vi.fn(async () => undefined);
    const bad = refineDeps(sites(), { claimSiteEditLease: vi.fn(async () => ({ release: r2 })) });
    bad.tryAcquireBuildSlot.mockRejectedValueOnce(new Error("slot busy"));
    await expect(refineProduct({ tenant_id: T1, message: MSG, conductor_run_id: RA }, bad as unknown as RefineProductDeps)).rejects.toThrow("slot busy");
    expect(r2).toHaveBeenCalledTimes(1);
  });

  it("an unreadable lease refuses (fails closed); a second edit mid-acquisition reads as a build in flight", async () => {
    const unknown = refineDeps(sites(), { claimSiteEditLease: vi.fn(async () => ({ held: "unknown" as const })) });
    await expect(refineProduct({ tenant_id: T1, message: MSG, conductor_run_id: RA }, unknown as unknown as RefineProductDeps)).rejects.toBeInstanceOf(SitePreviewRestarting);
    const editing = refineDeps(sites(), { claimSiteEditLease: vi.fn(async () => ({ held: "edit" as const })) });
    await expect(refineProduct({ tenant_id: T1, message: MSG, conductor_run_id: RA }, editing as unknown as RefineProductDeps)).rejects.toBeInstanceOf(DoubleBuildInFlight);
    expect(unknown.tryAcquireBuildSlot).not.toHaveBeenCalled();
    expect(editing.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });

  it("an undo on that site is refused before the slot, the claim and the revert", async () => {
    const { d, republish } = undoDeps(sites(), { claimSiteEditLease: restartingOn(SA) });
    const err = await refineUndo({ tenant_id: T1, conductor_run_id: "ref-a" }, d as unknown as RefineUndoDeps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UndoBlocked);
    expect((err as UndoBlocked).reason).toBe("build_in_progress");
    expect((err as Error).message).toMatch(/restarting/);
    expect(republish.reserve).not.toHaveBeenCalled();
    expect(d.claimUndoRun).not.toHaveBeenCalled();
    expect(d.revertOnMain).not.toHaveBeenCalled();
  });
});
