
import { describe, it, expect, vi } from "vitest";
import {
  refineProduct,
  DEFAULT_REFINE_MAX_USD,
  NoProvisionedRepo,
  ConductorRunNotFound,
  OldSiteFrozen,
  InvalidRefineMessage,
  PRIOR_REFINES_PROMPT_CONTEXT,
  extractRefineDiffSummary,
  REFINE_DIFF_SUMMARY_MAX_PATHS,
  type RefineProductDeps,
  type PriorRefineTurn,
} from "@/services/agents/refine-product";
import {
  MAX_PRODUCT_BUILD_MAX_USD,
  MAX_PRODUCT_REFINES_PER_DAY,
  DoubleBuildInFlight,
  TooManyBuildsToday,
  ProvisionBudgetExceeded,
} from "@/services/agents/start-product-build";
import type { ProvisionedTarget } from "@/services/agents/autopilot-pipeline-contract";
import type { ConductorNode } from "@/services/agents/conductor";
import { SITE_ROOT_RUN, testSite } from "./fixtures/refine-site";

const TARGET: ProvisionedTarget = {
  repo_url: "https://github.com/praxis-built/old-app",
  github_full_name: "praxis-built/old-app",
  default_branch: "main",
  neon_project_id: "np_123",
};
const SITE = testSite();

function deps(over: Partial<RefineProductDeps> = {}): RefineProductDeps & {
  loadProvisionedTarget: ReturnType<typeof vi.fn>;
  loadPriorRefines: ReturnType<typeof vi.fn>;
  verifyConductorRunOwnership: ReturnType<typeof vi.fn>;
  tryAcquireBuildSlot: ReturnType<typeof vi.fn>;
  updateConductorRunStatus: ReturnType<typeof vi.fn>;
  resolveDailyCap: ReturnType<typeof vi.fn>;
  loadRepoHeadSha: ReturnType<typeof vi.fn>;
  resolveRefineDirectMergeEnabled: ReturnType<typeof vi.fn>;
} {
  return {
    loadProvisionedTarget: vi.fn().mockResolvedValue(null),
    loadPriorRefines: vi.fn().mockResolvedValue([] as PriorRefineTurn[]),
    verifyConductorRunOwnership: vi.fn().mockResolvedValue(true),
    loadConductorRunKind: vi.fn().mockResolvedValue("build_app"),
    listSites: vi.fn().mockResolvedValue([SITE]),
    loadSiteForRun: vi.fn().mockResolvedValue(null),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_refine_1"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    loadRepoHeadSha: vi.fn().mockResolvedValue("pre0refine0sha0000"),
    resolveRefineDirectMergeEnabled: vi.fn().mockResolvedValue(true),
    isFleetHalted: vi.fn().mockResolvedValue(false),
    loadAppPolicy: vi
      .fn()
      .mockResolvedValue({ protected_globs: [], freeze: false, preview: "branch_preview" }),
    ...over,
  } as RefineProductDeps & {
    loadProvisionedTarget: ReturnType<typeof vi.fn>;
    loadPriorRefines: ReturnType<typeof vi.fn>;
    verifyConductorRunOwnership: ReturnType<typeof vi.fn>;
    tryAcquireBuildSlot: ReturnType<typeof vi.fn>;
    updateConductorRunStatus: ReturnType<typeof vi.fn>;
    resolveDailyCap: ReturnType<typeof vi.fn>;
    loadRepoHeadSha: ReturnType<typeof vi.fn>;
    resolveRefineDirectMergeEnabled: ReturnType<typeof vi.fn>;
  };
}

const BASE = {
  tenant_id: "t1",
  message: "make the dark-mode toggle in the top-right corner",
};

function graphFromUpdate(d: ReturnType<typeof deps>): ConductorNode[] {
  for (const call of d.updateConductorRunStatus.mock.calls) {
    const arg = call[0] as { goal_graph?: ConductorNode[]; status?: string };
    if (arg.goal_graph) return arg.goal_graph;
  }
  throw new Error("no updateConductorRunStatus call carried a goal_graph");
}

describe("refineProduct — Phase-A emergency brake (refine_direct_merge_enabled=false)", () => {
  const braked = () =>
    deps({ resolveRefineDirectMergeEnabled: vi.fn().mockResolvedValue(false) });

  it("brake ON (setting false): 1-node graph — engineer refine node only, NO deploy gate", async () => {
    const d = braked();
    await refineProduct(BASE, d);
    const graph = graphFromUpdate(d);
    expect(graph).toHaveLength(1);
    expect(graph[0].target_agent_slug).toBe("engineer");
    expect(graph[0].payload.stage).toBe("build");
    expect(graph[0].payload.refine_mode).toBe(true);
    expect(graph.some((n) => (n.payload as { stage?: string }).stage === "deploy")).toBe(
      false,
    );
  });

  it("brake ON: skips the pre-refine HEAD snapshot (nothing waits on HEAD to advance)", async () => {
    const d = braked();
    await refineProduct(BASE, d);
    expect(d.loadRepoHeadSha).not.toHaveBeenCalled();
  });

  it("brake ON: the setting is resolved per-tenant at graph-build time", async () => {
    const d = braked();
    await refineProduct(BASE, d);
    expect(d.resolveRefineDirectMergeEnabled).toHaveBeenCalledWith("t1");
  });

  it("FAIL-CLOSED: a throwing setting resolver brakes (1-node graph) — never legacy-merges on an unreadable setting", async () => {
    const d = deps({
      resolveRefineDirectMergeEnabled: vi
        .fn()
        .mockRejectedValue(new Error("settings table down")),
    });
    const r = await refineProduct(BASE, d);
    expect(r.conductor_run_id).toBe("cr_refine_1");
    const graph = graphFromUpdate(d);
    expect(graph).toHaveLength(1);
    expect(d.loadRepoHeadSha).not.toHaveBeenCalled();
  });

  it("kill-test C: setting true = legacy behavior byte-identical (2-node graph with deploy gate + HEAD snapshot)", async () => {
    const d = deps({
      resolveRefineDirectMergeEnabled: vi.fn().mockResolvedValue(true),
    });
    await refineProduct(BASE, d);
    const graph = graphFromUpdate(d);
    expect(graph).toHaveLength(2);
    expect(graph[1].payload.stage).toBe("deploy");
    expect(graph[1].payload.pre_refine_sha).toBe("pre0refine0sha0000");
    expect(d.loadRepoHeadSha).toHaveBeenCalledWith("praxis-built/acme", "main");
  });
});

describe("refineProduct — images attached in chat reach the engineer", () => {
  const T = "b92dcbf1-bac9-457a-af81-0bbe5984339b";
  const OTHER = "73db45ff-457e-4541-bc8f-bdb625390204";
  const mine = `${T}/0f0f0f0f-1c87-483f-9930-4a18bc701015.jpg`;

  it("carries the tenant's own chat image paths onto the engineer payload, dropping anyone else's and junk", async () => {
    const d = deps({ listSites: vi.fn().mockResolvedValue([testSite({ tenant_id: T })]) });
    await refineProduct(
      {
        ...BASE,
        tenant_id: T,
        photo_paths: [mine, `${OTHER}/1f0f0f0f-1c87-483f-9930-4a18bc701015.jpg`, `${T}/../x.jpg`, mine, `${T}/nope.png`],
      },
      d,
    );
    const graph = graphFromUpdate(d);
    expect((graph[0].payload as { chat_photo_paths?: string[] }).chat_photo_paths).toEqual([mine]);
  });

  it("leaves the payload without chat_photo_paths when nothing valid was attached", async () => {
    const d = deps({ listSites: vi.fn().mockResolvedValue([testSite({ tenant_id: T })]) });
    await refineProduct({ ...BASE, tenant_id: T, photo_paths: [`${OTHER}/1f0f0f0f-1c87-483f-9930-4a18bc701015.jpg`] }, d);
    expect((graphFromUpdate(d)[0].payload as Record<string, unknown>).chat_photo_paths).toBeUndefined();
  });
});

describe("refineProduct — chat_thread_id threading", () => {
  it("threads chat_thread_id onto the engineer node payload when provided", async () => {
    const d = deps();
    await refineProduct({ ...BASE, chat_thread_id: "thr-abc-123" }, d);
    const graph = graphFromUpdate(d);
    expect((graph[0].payload as { chat_thread_id?: string }).chat_thread_id).toBe(
      "thr-abc-123",
    );
  });

  it("omits chat_thread_id when the refine has no originating chat thread", async () => {
    const d = deps();
    await refineProduct(BASE, d);
    const graph = graphFromUpdate(d);
    expect(
      (graph[0].payload as { chat_thread_id?: string }).chat_thread_id,
    ).toBeUndefined();
  });
});

describe("refineProduct", () => {
  it("builds a 2-node goal_graph: engineer build node + trailing deploy gate", async () => {
    const d = deps();
    await refineProduct(BASE, d);
    const graph = graphFromUpdate(d);
    expect(graph).toHaveLength(2);
    expect(graph[0].target_agent_slug).toBe("engineer");
    expect(graph[1].payload.stage).toBe("deploy");
  });

  it("the engineer node dispatches in refine_mode against the provisioned target", async () => {
    const d = deps();
    await refineProduct(BASE, d);
    const graph = graphFromUpdate(d);
    const node = graph[0];
    expect(node.target_agent_slug).toBe("engineer");
    expect(node.status).toBe("pending");
    expect(node.payload.stage).toBe("build");
    expect(node.payload.refine_mode).toBe(true);
    expect(node.payload.idea).toBe(BASE.message);
    expect(node.payload.target).toMatchObject({
      github_full_name: "praxis-built/acme",
      repo_url: "https://github.com/praxis-built/acme",
    });
  });

  it("REFINE DEPLOY GATE: trailing node is a no-dispatch deploy gate carrying the pre-refine HEAD snapshot + an enqueue timestamp", async () => {
    const d = deps();
    await refineProduct(BASE, d);
    const graph = graphFromUpdate(d);
    const gate = graph[1];
    expect(gate.target_agent_slug).toBe("");
    expect(gate.estimate_usd).toBe(0);
    expect(gate.status).toBe("pending");
    expect(gate.payload.stage).toBe("deploy");
    expect(gate.payload.pre_refine_sha).toBe("pre0refine0sha0000");
    expect(typeof gate.payload.refine_deploy_enqueued_at).toBe("number");
    expect(gate.payload.target).toMatchObject({ github_full_name: "praxis-built/acme" });
    expect(d.loadRepoHeadSha).toHaveBeenCalledWith("praxis-built/acme", "main");
  });

  it("REFINE DEPLOY GATE: a null HEAD snapshot (unreadable at enqueue) OMITS pre_refine_sha — gate degrades to content-verify-only, still appended", async () => {
    const d = deps({ loadRepoHeadSha: vi.fn().mockResolvedValue(null) });
    await refineProduct(BASE, d);
    const graph = graphFromUpdate(d);
    expect(graph).toHaveLength(2);
    const gate = graph[1];
    expect(gate.payload.stage).toBe("deploy");
    expect("pre_refine_sha" in (gate.payload as Record<string, unknown>)).toBe(false);
  });

  it("REFINE DEPLOY GATE: a THROWING HEAD read never blocks the enqueue (best-effort → omit pre_refine_sha)", async () => {
    const d = deps({
      loadRepoHeadSha: vi.fn().mockRejectedValue(new Error("github 503")),
    });
    const r = await refineProduct(BASE, d);
    expect(r.conductor_run_id).toBe("cr_refine_1");
    const graph = graphFromUpdate(d);
    expect("pre_refine_sha" in (graph[1].payload as Record<string, unknown>)).toBe(false);
  });

  it("acquires the slot via tryAcquireBuildSlot and flips to active", async () => {
    const d = deps();
    const r = await refineProduct(BASE, d);
    expect(d.tryAcquireBuildSlot).toHaveBeenCalledTimes(1);
    expect(d.updateConductorRunStatus).toHaveBeenCalledTimes(1);
    expect(d.updateConductorRunStatus.mock.calls[0][0]).toMatchObject({
      conductor_run_id: "cr_refine_1",
      status: "active",
    });
    expect(r.conductor_run_id).toBe("cr_refine_1");
  });

  it("does NOT call provisionCompany — no provisioning dep in refineProduct", () => {
    const d = deps();
    const keys = Object.keys(d);
    expect(keys).not.toContain("provision");
    expect(keys).not.toContain("seedRepo");
    expect(keys).not.toContain("ensureGithubConnector");
  });

  it("max_usd defaults to DEFAULT_REFINE_MAX_USD ($5)", async () => {
    const d = deps();
    await refineProduct(BASE, d);
    expect(d.tryAcquireBuildSlot.mock.calls[0][0].max_usd).toBe(
      DEFAULT_REFINE_MAX_USD,
    );
    expect(DEFAULT_REFINE_MAX_USD).toBe(5);
  });

  it("honors an explicit max_usd within the ceiling", async () => {
    const d = deps();
    await refineProduct({ ...BASE, max_usd: 8 }, d);
    expect(d.tryAcquireBuildSlot.mock.calls[0][0].max_usd).toBe(8);
  });

  it("CLAMPS max_usd to the server ceiling — no caller can persist an unbounded cap", async () => {
    const d = deps();
    await refineProduct({ ...BASE, max_usd: 1_000_000 }, d);
    expect(d.tryAcquireBuildSlot.mock.calls[0][0].max_usd).toBe(
      MAX_PRODUCT_BUILD_MAX_USD,
    );
  });

  it("coerces null/negative max_usd to DEFAULT_REFINE_MAX_USD (never null cap)", async () => {
    const d = deps();
    await refineProduct({ ...BASE, max_usd: null }, d);
    expect(d.tryAcquireBuildSlot.mock.calls[0][0].max_usd).toBe(
      DEFAULT_REFINE_MAX_USD,
    );
  });

  it("acquire uses the SEPARATE refine daily bucket (is_refine=true, cap=MAX_PRODUCT_REFINES_PER_DAY)", async () => {
    const d = deps();
    await refineProduct(BASE, d);
    const arg = d.tryAcquireBuildSlot.mock.calls[0][0];
    expect(arg.max_per_day).toBe(MAX_PRODUCT_REFINES_PER_DAY);
    expect(arg.is_refine).toBe(true);
    expect(typeof arg.daily_cap_usd).toBe("number");
    expect(arg.provision_estimate).toBe(0);
  });

  it("acquire objective text gets a [refine] prefix for UI distinction", async () => {
    const d = deps();
    await refineProduct(BASE, d);
    const objective = d.tryAcquireBuildSlot.mock.calls[0][0].objective;
    expect(objective).toContain("[refine]");
    expect(objective).toContain("dark-mode toggle");
  });

  it("rejects when no site and no old app exist (NoProvisionedRepo)", async () => {
    const d = deps({ listSites: vi.fn().mockResolvedValue([]), loadProvisionedTarget: vi.fn().mockResolvedValue(null) });
    await expect(refineProduct(BASE, d)).rejects.toBeInstanceOf(NoProvisionedRepo);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });

  it("rejects when the site has no repo", async () => {
    const d = deps({
      listSites: vi.fn().mockResolvedValue([testSite({ github_full_name: null })]),
    });
    await expect(refineProduct(BASE, d)).rejects.toBeInstanceOf(NoProvisionedRepo);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });

  it("rejects on too-short / too-long message (InvalidRefineMessage)", async () => {
    const d = deps();
    await expect(refineProduct({ ...BASE, message: "hi" }, d)).rejects.toBeInstanceOf(
      InvalidRefineMessage,
    );
    await expect(
      refineProduct({ ...BASE, message: "x".repeat(4001) }, d),
    ).rejects.toBeInstanceOf(InvalidRefineMessage);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    expect(d.loadProvisionedTarget).not.toHaveBeenCalled();
  });

  it("verifies a caller-supplied conductor_run_id belongs to this tenant", async () => {
    const d = deps({
      verifyConductorRunOwnership: vi.fn().mockResolvedValue(false),
    });
    await expect(
      refineProduct({ ...BASE, conductor_run_id: "cr_other_tenant" }, d),
    ).rejects.toBeInstanceOf(ConductorRunNotFound);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });

  describe("old-pipeline freeze (2026-10-02): the old-flow app is never edited", () => {
    it("refuses a refine bound to an old-flow build session, before any state", async () => {
      const d = deps({ loadSiteForRun: vi.fn().mockResolvedValue(null) });
      await expect(refineProduct({ ...BASE, conductor_run_id: "cr_old_build" }, d)).rejects.toBeInstanceOf(OldSiteFrozen);
      expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
      expect(d.updateConductorRunStatus).not.toHaveBeenCalled();
    });

    it("refuses a session whose site fell back to the old flow", async () => {
      const d = deps({ loadSiteForRun: vi.fn().mockResolvedValue(testSite({ status: "fell_back_old" })) });
      await expect(refineProduct({ ...BASE, conductor_run_id: "cr_old_build" }, d)).rejects.toBeInstanceOf(OldSiteFrozen);
      expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    });

    it("refuses an unbound refine when the only app is the old-flow app", async () => {
      const d = deps({
        listSites: vi.fn().mockResolvedValue([]),
        loadProvisionedTarget: vi.fn().mockResolvedValue({ ...TARGET }),
      });
      await expect(refineProduct(BASE, d)).rejects.toBeInstanceOf(OldSiteFrozen);
      expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    });

    it("refuses the Home composer's workspace-app edit (singleton_app) without reading anything", async () => {
      const d = deps();
      await expect(refineProduct({ ...BASE, singleton_app: true }, d)).rejects.toBeInstanceOf(OldSiteFrozen);
      expect(d.listSites).not.toHaveBeenCalled();
      expect(d.loadProvisionedTarget).not.toHaveBeenCalled();
      expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    });

    it("the frozen refusal comes before the fleet gate and the credit pre-flight", async () => {
      const d = deps({
        listSites: vi.fn().mockResolvedValue([]),
        loadProvisionedTarget: vi.fn().mockResolvedValue({ ...TARGET }),
        isFleetHalted: vi.fn().mockResolvedValue(true),
      });
      await expect(refineProduct(BASE, d)).rejects.toBeInstanceOf(OldSiteFrozen);
    });

    it("a site session edits that site's repo, never the old-flow repo", async () => {
      const d = deps({
        loadSiteForRun: vi.fn().mockResolvedValue(SITE),
        loadProvisionedTarget: vi.fn().mockResolvedValue({ ...TARGET }),
      });
      const r = await refineProduct({ ...BASE, conductor_run_id: SITE_ROOT_RUN }, d);
      expect(r.target.github_full_name).toBe("praxis-built/acme");
      expect(r.site_id).toBe(SITE.id);
    });

    it("company_goal lineage names no app: the unbound site resolution applies", async () => {
      const d = deps({ loadConductorRunKind: vi.fn().mockResolvedValue("company_goal") });
      const r = await refineProduct({ ...BASE, conductor_run_id: "cr_company_goal" }, d);
      expect(r.site_id).toBe(SITE.id);
      expect(r.parent_conductor_run_id).toBe(SITE_ROOT_RUN);
    });
  });

  it("records the site's root build as parent_conductor_run_id on the result + in payload", async () => {
    const d = deps({ loadSiteForRun: vi.fn().mockResolvedValue(SITE) });
    const r = await refineProduct(
      { ...BASE, conductor_run_id: "cr_prior" },
      d,
    );
    expect(r.parent_conductor_run_id).toBe(SITE_ROOT_RUN);
    const graph = graphFromUpdate(d);
    expect(graph[0].payload.parent_conductor_run_id).toBe(SITE_ROOT_RUN);
  });

  it("maps SQL-side rejections to typed errors (DoubleBuildInFlight / TooManyBuildsToday / ProvisionBudgetExceeded)", async () => {
    const dDbl = deps({
      tryAcquireBuildSlot: vi.fn().mockRejectedValue(new DoubleBuildInFlight("t1")),
    });
    await expect(refineProduct(BASE, dDbl)).rejects.toBeInstanceOf(DoubleBuildInFlight);

    const dCap = deps({
      tryAcquireBuildSlot: vi.fn().mockRejectedValue(new TooManyBuildsToday("t1", 10, 10)),
    });
    await expect(refineProduct(BASE, dCap)).rejects.toBeInstanceOf(TooManyBuildsToday);

    const dBudget = deps({
      tryAcquireBuildSlot: vi.fn().mockRejectedValue(new ProvisionBudgetExceeded(0)),
    });
    await expect(refineProduct(BASE, dBudget)).rejects.toBeInstanceOf(
      ProvisionBudgetExceeded,
    );
  });

  it("threads prior_refines onto the node payload (last 3 turns for engineer context)", async () => {
    const priors: PriorRefineTurn[] = [
      { message: "make the header sticky", status: "success", outcome: "Made header sticky in app/layout.tsx" },
      { message: "add a contact email field", status: "success", outcome: "Added contact field to signup form" },
      { message: "switch palette to dark mode", status: "active" },
    ];
    const d = deps({
      loadPriorRefines: vi.fn().mockResolvedValue(priors),
    });
    await refineProduct(BASE, d);
    expect(d.loadPriorRefines).toHaveBeenCalledTimes(1);
    expect(d.loadPriorRefines).toHaveBeenCalledWith("t1", PRIOR_REFINES_PROMPT_CONTEXT, SITE.id);
    const graph = graphFromUpdate(d);
    expect(graph[0].payload.prior_refines).toEqual(priors);
  });

  it("empty prior_refines array when no priors exist (still on payload — defensive)", async () => {
    const d = deps();
    await refineProduct(BASE, d);
    const graph = graphFromUpdate(d);
    expect(graph[0].payload.prior_refines).toEqual([]);
  });

  it("loadPriorRefines failure does NOT block the refine (best-effort context)", async () => {
    const d = deps({
      loadPriorRefines: vi.fn().mockRejectedValue(new Error("supabase down")),
    });
    const r = await refineProduct(BASE, d);
    expect(r.conductor_run_id).toBe("cr_refine_1");
    const graph = graphFromUpdate(d);
    expect(graph[0].payload.prior_refines).toEqual([]);
  });

  it("best-effort slot release ('failed' flip) when the post-acquire path throws", async () => {
    let callCount = 0;
    const d = deps({
      updateConductorRunStatus: vi.fn().mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) throw new Error("simulated post-acquire failure");
        return undefined;
      }),
    });
    await expect(refineProduct(BASE, d)).rejects.toThrow("simulated post-acquire failure");
    expect(d.updateConductorRunStatus).toHaveBeenCalledTimes(2);
    expect(d.updateConductorRunStatus.mock.calls[1][0]).toMatchObject({
      conductor_run_id: "cr_refine_1",
      status: "failed",
    });
  });
});

describe("extractRefineDiffSummary", () => {
  const SHA = "a".repeat(40);

  function envelope(body: Record<string, unknown>): string {
    return `Here is what I did.\n<pr_proposal>${JSON.stringify(body)}</pr_proposal>\nDone.`;
  }

  it("returns null on null / empty / no-envelope output", () => {
    expect(extractRefineDiffSummary(null)).toBeNull();
    expect(extractRefineDiffSummary(undefined)).toBeNull();
    expect(extractRefineDiffSummary("")).toBeNull();
    expect(extractRefineDiffSummary("just some text, no envelope")).toBeNull();
  });

  it("returns null on a malformed (unparseable JSON) envelope", () => {
    expect(
      extractRefineDiffSummary("<pr_proposal>{not json,,}</pr_proposal>"),
    ).toBeNull();
  });

  it("parses summary, commit_sha, pr_url, files + per-action tallies", () => {
    const out = envelope({
      summary: "made the header sticky",
      commit_sha: SHA,
      pr_url: "https://github.com/praxis-built/acme/pull/4",
      files: [
        { path: "src/Header.tsx", action: "modify", content: "x" },
        { path: "src/Footer.tsx", action: "modify", content: "y" },
        { path: "src/NewBanner.tsx", action: "create", content: "z" },
        { path: "src/Old.tsx", action: "delete" },
      ],
    });
    const r = extractRefineDiffSummary(out)!;
    expect(r.summary).toBe("made the header sticky");
    expect(r.commit_sha).toBe(SHA);
    expect(r.pr_url).toBe("https://github.com/praxis-built/acme/pull/4");
    expect(r.files_changed).toBe(4);
    expect(r.file_paths).toEqual([
      "src/Footer.tsx",
      "src/Header.tsx",
      "src/NewBanner.tsx",
      "src/Old.tsx",
    ]);
    expect(r.actions).toEqual({ create: 1, modify: 2, delete: 1 });
  });

  it("accepts the legacy `sha` alias (parity with refine-undo)", () => {
    const r = extractRefineDiffSummary(envelope({ summary: "x", sha: SHA }))!;
    expect(r.commit_sha).toBe(SHA);
  });

  it("nulls out a malformed commit_sha + a non-http pr_url (never ships junk)", () => {
    const r = extractRefineDiffSummary(
      envelope({ summary: "x", commit_sha: "not-a-sha", pr_url: "ftp://x" }),
    )!;
    expect(r.commit_sha).toBeNull();
    expect(r.pr_url).toBeNull();
  });

  it("an envelope with no files yields files_changed=0 but keeps summary+sha", () => {
    const r = extractRefineDiffSummary(envelope({ summary: "tweak", commit_sha: SHA }))!;
    expect(r.summary).toBe("tweak");
    expect(r.commit_sha).toBe(SHA);
    expect(r.files_changed).toBe(0);
    expect(r.file_paths).toEqual([]);
    expect(r.actions).toEqual({ create: 0, modify: 0, delete: 0 });
  });

  it("caps the preview path list but reports the TRUE files_changed count", () => {
    const files = Array.from({ length: REFINE_DIFF_SUMMARY_MAX_PATHS + 10 }, (_, i) => ({
      path: `src/f${String(i).padStart(3, "0")}.tsx`,
      action: "modify" as const,
      content: "x",
    }));
    const r = extractRefineDiffSummary(envelope({ summary: "big", commit_sha: SHA, files }))!;
    expect(r.files_changed).toBe(REFINE_DIFF_SUMMARY_MAX_PATHS + 10);
    expect(r.file_paths).toHaveLength(REFINE_DIFF_SUMMARY_MAX_PATHS);
    expect(r.actions.modify).toBe(REFINE_DIFF_SUMMARY_MAX_PATHS + 10);
  });

  it("skips file entries with a missing/blank path without throwing", () => {
    const r = extractRefineDiffSummary(
      envelope({
        summary: "x",
        commit_sha: SHA,
        files: [
          { path: "  ", action: "modify" },
          { action: "create", content: "z" },
          { path: "src/Real.tsx", action: "create", content: "z" },
        ],
      }),
    )!;
    expect(r.files_changed).toBe(1);
    expect(r.file_paths).toEqual(["src/Real.tsx"]);
    expect(r.actions).toEqual({ create: 1, modify: 0, delete: 0 });
  });
});
