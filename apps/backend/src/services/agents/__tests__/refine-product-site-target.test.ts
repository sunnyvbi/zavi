
import { describe, it, expect, vi, type Mock } from "vitest";
import {
  refineProduct,
  resolveUnboundSite,
  SiteRequired,
  OldSiteFrozen,
  ConductorRunNotFound,
  type RefineProductDeps,
  type PriorRefineTurn,
} from "@/services/agents/refine-product";
import type { ConductorNode } from "@/services/agents/conductor";
import type { SiteRow } from "@/services/sites/contract";

const TENANT = "t-own";
const OLD_REPO = "Zavi-Latest-Build/apna-tutor-693dfbdb";

function site(id: string, root: string, repo: string, status: SiteRow["status"] = "live", tenant = TENANT): SiteRow {
  return {
    id,
    tenant_id: tenant,
    root_conductor_run_id: root,
    status,
    github_full_name: repo,
    hostname: `${id}.zaviagent.com`,
  } as unknown as SiteRow;
}

const LUCKY = site("11111111-1111-4111-8111-111111111111", "aaaaaaaa-0000-4000-8000-00000000000a", "Praxis-build/lucky-paws");
const MILE = site("22222222-2222-4222-8222-222222222222", "bbbbbbbb-0000-4000-8000-00000000000b", "Praxis-build/mile-high");
const FOREIGN = site("33333333-3333-4333-8333-333333333333", "cccccccc-0000-4000-8000-00000000000c", "Praxis-build/other", "live", "t-other");

type MockDeps = RefineProductDeps & { [K in keyof RefineProductDeps]: Mock };

function deps(opts: {
  sites?: SiteRow[];
  oldRepo?: string | null;
  ownedRuns?: string[];
  kinds?: Record<string, string>;
  listThrows?: boolean;
  over?: Partial<RefineProductDeps>;
} = {}): MockDeps {
  const sites = opts.sites ?? [];
  const owned = new Set(opts.ownedRuns ?? sites.filter((s) => s.tenant_id === TENANT).map((s) => s.root_conductor_run_id));
  return {
    loadProvisionedTarget: vi.fn().mockResolvedValue(
      opts.oldRepo === null || opts.oldRepo === undefined
        ? null
        : { github_full_name: opts.oldRepo, repo_url: `https://github.com/${opts.oldRepo}`, default_branch: "main" },
    ),
    loadPriorRefines: vi.fn().mockResolvedValue([] as PriorRefineTurn[]),
    verifyConductorRunOwnership: vi.fn(async (id: string, tenant: string) => tenant === TENANT && owned.has(id)),
    loadConductorRunKind: vi.fn(async (id: string) => opts.kinds?.[id] ?? "build_app"),
    loadSiteForRun: vi.fn(async (tenant: string, id: string) =>
      sites.find((s) => s.tenant_id === tenant && s.root_conductor_run_id === id) ?? null,
    ),
    listSites: vi.fn(async (tenant: string) => {
      if (opts.listThrows) throw new Error("sites unreachable");
      return sites.filter((s) => s.tenant_id === tenant);
    }),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_refine_new"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    loadRepoHeadSha: vi.fn().mockResolvedValue("presha"),
    resolveRefineDirectMergeEnabled: vi.fn().mockResolvedValue(true),
    isFleetHalted: vi.fn().mockResolvedValue(false),
    loadAppPolicy: vi.fn().mockResolvedValue({ protected_globs: [], freeze: false, preview: "branch_preview" }),
    ...opts.over,
  } as unknown as MockDeps;
}

function graph(d: MockDeps): ConductorNode[] {
  for (const call of d.updateConductorRunStatus.mock.calls) {
    const arg = call[0] as { goal_graph?: ConductorNode[] };
    if (arg.goal_graph) return arg.goal_graph;
  }
  throw new Error("no goal_graph written");
}

function targetRepo(d: MockDeps): string | undefined {
  const node = graph(d)[0];
  return ((node.payload as Record<string, unknown>).target as { github_full_name?: string } | undefined)?.github_full_name;
}

const MSG = "Change the hero headline to: Austin's happiest dogs";

describe("refineProduct target in a workspace with several sites (B6)", () => {
  it("an edit bound to site A goes to A's repo, one bound to B to B's, never the old app", async () => {
    const dA = deps({ sites: [LUCKY, MILE], oldRepo: OLD_REPO });
    const a = await refineProduct({ tenant_id: TENANT, message: MSG, conductor_run_id: LUCKY.root_conductor_run_id }, dA);
    expect(a.site_id).toBe(LUCKY.id);
    expect(targetRepo(dA)).toBe("Praxis-build/lucky-paws");
    expect(a.parent_conductor_run_id).toBe(LUCKY.root_conductor_run_id);
    expect(dA.loadProvisionedTarget).not.toHaveBeenCalled();

    const dB = deps({ sites: [LUCKY, MILE], oldRepo: OLD_REPO });
    const b = await refineProduct({ tenant_id: TENANT, message: MSG, conductor_run_id: MILE.root_conductor_run_id }, dB);
    expect(b.site_id).toBe(MILE.id);
    expect(targetRepo(dB)).toBe("Praxis-build/mile-high");
    for (const n of graph(dB)) {
      if ((n.payload as Record<string, unknown>).site_id !== undefined) {
        expect((n.payload as Record<string, unknown>).site_id).toBe(MILE.id);
      }
    }
  });

  it("an unreadable run kind does not drop a site session onto the old repo", async () => {
    const d = deps({
      sites: [LUCKY, MILE],
      oldRepo: OLD_REPO,
      over: { loadConductorRunKind: vi.fn().mockRejectedValue(new Error("blip")) },
    });
    const r = await refineProduct({ tenant_id: TENANT, message: MSG, conductor_run_id: MILE.root_conductor_run_id }, d);
    expect(r.site_id).toBe(MILE.id);
    expect(targetRepo(d)).toBe("Praxis-build/mile-high");
  });

  it("an unreadable run kind with no site for the run is refused as retryable, never sent to the tenant's one site", async () => {
    const OLD_RUN = "dddddddd-0000-4000-8000-00000000000d";
    for (const failing of [vi.fn().mockRejectedValue(new Error("blip")), vi.fn().mockResolvedValue(null)]) {
      const d = deps({ sites: [MILE], ownedRuns: [OLD_RUN, MILE.root_conductor_run_id!], over: { loadConductorRunKind: failing } });
      const err = await refineProduct({ tenant_id: TENANT, message: MSG, conductor_run_id: OLD_RUN }, d).catch((e) => e);
      expect(err).toBeInstanceOf(SiteRequired);
      expect((err as SiteRequired).reason).toBe("unreadable");
      expect(d.listSites).not.toHaveBeenCalled();
      expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
      expect(d.updateConductorRunStatus).not.toHaveBeenCalled();
    }
  });

  it("a failed site lookup for the run is refused as retryable, never guessed", async () => {
    const d = deps({
      sites: [MILE],
      over: { loadSiteForRun: vi.fn().mockRejectedValue(new Error("sites down")) },
    });
    const err = await refineProduct({ tenant_id: TENANT, message: MSG, conductor_run_id: MILE.root_conductor_run_id }, d).catch((e) => e);
    expect(err).toBeInstanceOf(SiteRequired);
    expect((err as SiteRequired).reason).toBe("unreadable");
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });

  it("a readable non-build kind (suggestion lineage) still takes the unbound resolution", async () => {
    const RUN = "eeeeeeee-0000-4000-8000-00000000000e";
    const d = deps({ sites: [MILE], ownedRuns: [RUN, MILE.root_conductor_run_id!], kinds: { [RUN]: "company_goal" } });
    const r = await refineProduct({ tenant_id: TENANT, message: MSG, conductor_run_id: RUN }, d);
    expect(r.site_id).toBe(MILE.id);
  });

  it("an UNBOUND edit (the operator handoff with no session) is refused when several apps exist", async () => {
    const d = deps({ sites: [LUCKY, MILE], oldRepo: OLD_REPO });
    await expect(refineProduct({ tenant_id: TENANT, message: MSG }, d)).rejects.toBeInstanceOf(SiteRequired);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    expect(d.updateConductorRunStatus).not.toHaveBeenCalled();
  });

  it("an unbound edit with ONE site plus the old app is refused too (still two apps)", async () => {
    const d = deps({ sites: [MILE], oldRepo: OLD_REPO });
    const err = await refineProduct({ tenant_id: TENANT, message: MSG }, d).catch((e) => e);
    expect(err).toBeInstanceOf(SiteRequired);
    expect((err as SiteRequired).reason).toBe("ambiguous");
  });

  it("an unbound edit with exactly one open site and no old app targets that site", async () => {
    const failed = site("44444444-4444-4444-8444-444444444444", "dddddddd-0000-4000-8000-00000000000d", "Praxis-build/dead", "failed");
    const d = deps({ sites: [MILE, failed], oldRepo: null });
    const r = await refineProduct({ tenant_id: TENANT, message: MSG }, d);
    expect(r.site_id).toBe(MILE.id);
    expect(targetRepo(d)).toBe("Praxis-build/mile-high");
    expect(r.parent_conductor_run_id).toBe(MILE.root_conductor_run_id);
  });

  it("a site list that cannot be read refuses (fail closed), never falls back to the old repo", async () => {
    const d = deps({ sites: [MILE], oldRepo: OLD_REPO, listThrows: true });
    const err = await refineProduct({ tenant_id: TENANT, message: MSG }, d).catch((e) => e);
    expect(err).toBeInstanceOf(SiteRequired);
    expect((err as SiteRequired).reason).toBe("unreadable");
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });

  it("an edit for the old app (singleton_app: Home, the old app's auto-fix) is refused beside sites", async () => {
    const d = deps({ sites: [LUCKY, MILE], oldRepo: OLD_REPO });
    await expect(refineProduct({ tenant_id: TENANT, message: MSG, singleton_app: true }, d)).rejects.toBeInstanceOf(OldSiteFrozen);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });

  it("an explicit old-flow build session is refused, never sent to a site or the old repo", async () => {
    const oldSession = "eeeeeeee-0000-4000-8000-00000000000e";
    const d = deps({ sites: [LUCKY, MILE], oldRepo: OLD_REPO, ownedRuns: [oldSession] });
    await expect(refineProduct({ tenant_id: TENANT, message: MSG, conductor_run_id: oldSession }, d)).rejects.toBeInstanceOf(OldSiteFrozen);
    expect(d.listSites).not.toHaveBeenCalled();
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });
});

describe("cross-tenant: another tenant's site session is refused", () => {
  it("a foreign site's root run id is ConductorRunNotFound, nothing is created", async () => {
    const d = deps({ sites: [LUCKY, FOREIGN], oldRepo: OLD_REPO });
    await expect(
      refineProduct({ tenant_id: TENANT, message: MSG, conductor_run_id: FOREIGN.root_conductor_run_id }, d),
    ).rejects.toBeInstanceOf(ConductorRunNotFound);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });

  it("even if ownership were skipped, a site row of another tenant is never used", async () => {
    const d = deps({
      sites: [LUCKY],
      oldRepo: OLD_REPO,
      ownedRuns: [FOREIGN.root_conductor_run_id!],
      over: { loadSiteForRun: vi.fn().mockResolvedValue(FOREIGN) },
    });
    await expect(
      refineProduct({ tenant_id: TENANT, message: MSG, conductor_run_id: FOREIGN.root_conductor_run_id }, d),
    ).rejects.toBeInstanceOf(OldSiteFrozen);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });

  it("the unbound resolver ignores rows that are not this tenant's", async () => {
    const d = deps({ sites: [], oldRepo: null, over: { listSites: vi.fn().mockResolvedValue([FOREIGN]) } });
    expect(await resolveUnboundSite(TENANT, d)).toBeNull();
  });
});

describe("old-flow single-app tenants are frozen (2026-10-02)", () => {
  it("no sites: an unbound edit is refused, the old repo is never edited", async () => {
    const d = deps({ sites: [], oldRepo: OLD_REPO });
    await expect(refineProduct({ tenant_id: TENANT, message: MSG }, d)).rejects.toBeInstanceOf(OldSiteFrozen);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    expect(d.updateConductorRunStatus).not.toHaveBeenCalled();
  });

  it("only dead sites (failed / fell back): still refused", async () => {
    const fell = site("55555555-5555-4555-8555-555555555555", "99999999-0000-4000-8000-000000000009", "Praxis-build/x", "fell_back_old");
    const failed = site("66666666-6666-4666-8666-666666666666", "88888888-0000-4000-8000-000000000008", "Praxis-build/y", "failed");
    const d = deps({ sites: [fell, failed], oldRepo: OLD_REPO });
    await expect(refineProduct({ tenant_id: TENANT, message: MSG }, d)).rejects.toBeInstanceOf(OldSiteFrozen);
  });

  it("priors are scoped to the site being edited", async () => {
    const d = deps({ sites: [LUCKY, MILE], oldRepo: OLD_REPO });
    await refineProduct({ tenant_id: TENANT, message: MSG, conductor_run_id: MILE.root_conductor_run_id }, d);
    expect(d.loadPriorRefines).toHaveBeenCalledWith(TENANT, expect.any(Number), MILE.id);
  });
});
