import { describe, it, expect, vi, type Mock } from "vitest";
import {
  refineProduct,
  OldSiteFrozen,
  SITE_FAST_EDIT_ESTIMATE_USD,
  type RefineProductDeps,
  type RefineProductInput,
  type PriorRefineTurn,
} from "@/services/agents/refine-product";
import type { ConductorNode } from "@/services/agents/conductor";
import type { SiteRow } from "@/services/sites/contract";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SESSION = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const SITE_ID = "aaaaaaaa-0000-4000-8000-000000000001";

const SITE: SiteRow = {
  id: SITE_ID,
  tenant_id: TENANT,
  root_conductor_run_id: SESSION,
  started_by_user_id: null,
  owner_email: "owner@example.test",
  label: "alpha",
  hostname: "alpha.zaviagent.com",
  github_full_name: "praxis-built/alpha",
  supabase_project_ref: "ref",
  supabase_url: "https://ref.supabase.co",
  status: "live",
  live_url: "https://alpha.zaviagent.com",
  desired_sha: "1111111",
  live_sha: "1111111",
  live_deploy_id: "d00000000a-live0001",
  last_visit_at: null,
  last_edit_at: null,
  paused_at: null,
  last_error: null,
  created_at: "2026-09-30T00:00:00Z",
  updated_at: "2026-09-30T00:00:00Z",
};

type MockDeps = RefineProductDeps & { [K in keyof RefineProductDeps]: Mock };

function deps(over: Partial<RefineProductDeps> = {}): MockDeps {
  return {
    loadProvisionedTarget: vi.fn().mockResolvedValue(null),
    loadPriorRefines: vi.fn().mockResolvedValue([] as PriorRefineTurn[]),
    verifyConductorRunOwnership: vi.fn().mockResolvedValue(true),
    loadConductorRunKind: vi.fn().mockResolvedValue("build_app"),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_refine_1"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    loadRepoHeadSha: vi.fn().mockResolvedValue("1111111"),
    resolveRefineDirectMergeEnabled: vi.fn().mockResolvedValue(true),
    isFleetHalted: vi.fn().mockResolvedValue(false),
    loadAppPolicy: vi.fn().mockResolvedValue({ protected_globs: [], freeze: false, preview: "branch_preview" }),
    loadSiteForRun: vi.fn().mockResolvedValue({ ...SITE }),
    markSiteEdited: vi.fn().mockResolvedValue(undefined),
    resolveSiteFastEditNode: vi.fn().mockResolvedValue(true),
    resolveSiteEditTimingLog: vi.fn().mockResolvedValue(true),
    resolveSiteEditAutoRoute: vi.fn().mockResolvedValue(true),
    ...over,
  } as unknown as MockDeps;
}

function graphOf(d: MockDeps): ConductorNode[] {
  for (const call of d.updateConductorRunStatus.mock.calls) {
    const arg = call[0] as { goal_graph?: ConductorNode[] };
    if (arg.goal_graph) return arg.goal_graph;
  }
  throw new Error("no goal_graph written");
}

const typed = (message: string, over: Partial<RefineProductInput> = {}): RefineProductInput => ({ tenant_id: TENANT, message, conductor_run_id: SESSION, ...over });

describe("refineProduct sizes a typed site change", () => {
  it.each([
    ['change the headline to "Fresh bread daily"', "bakery"],
    ["make the Book a visit button teal", "dentist"],
    ["fix the typo in the about text", "photographer"],
  ])("a clear tweak takes the fast pass: %s (%s)", async (message) => {
    const d = deps();
    await refineProduct(typed(message), d);
    const [engineer] = graphOf(d);
    expect(engineer.payload).toMatchObject({ fast_edit: true, small_edit: true, edit_size: "tweak", edit_routed: "auto" });
    expect(engineer.estimate_usd).toBe(SITE_FAST_EDIT_ESTIMATE_USD);
    expect(d.resolveSiteEditAutoRoute).toHaveBeenCalledWith(TENANT);
  });

  it.each([
    ["add a gallery page with my recent shoots", "page"],
    ["add a testimonials section under the hero", "section"],
    ["let patients book a cleaning online", "data"],
    ["add an order form for custom cakes", "data"],
  ])("a bigger change keeps the full pass with its size: %s", async (message, size) => {
    const d = deps();
    await refineProduct(typed(message), d);
    const [engineer] = graphOf(d);
    expect(engineer.payload).not.toHaveProperty("fast_edit");
    expect(engineer.payload).not.toHaveProperty("edit_routed");
    expect(engineer.payload).toMatchObject({ edit_size: size });
    expect(engineer.estimate_usd).toBe(3.0);
  });

  it("sizes the founder's request, not the engineer instruction", async () => {
    const d = deps();
    await refineProduct(typed("Instruction for the engineer: add a new page and a form", { request: "make the footer text grey" }), d);
    expect(graphOf(d)[0].payload).toMatchObject({ fast_edit: true, edit_size: "tweak" });
  });

  it.each([
    ["a retry", { retry_of: "dcee9f28-0000-4000-8000-000000000000" }],
    ["an auto-fix", { remediation_attempt: 1 }],
    ["a suggestion", { source_suggestion_id: "s-1" }],
  ])("%s of a tweak keeps the full pass", async (_label, over) => {
    const d = deps();
    await refineProduct(typed("make the call button green", over), d);
    const [engineer] = graphOf(d);
    expect(engineer.payload).not.toHaveProperty("fast_edit");
    expect(engineer.payload).toMatchObject({ edit_size: "tweak" });
  });

  it("a change that brings photos keeps the full pass", async () => {
    const d = deps();
    const msg =
      "Use this photo on the site: https://api.zaviagent.com/api/public/workspace-files/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/a.jpg";
    await refineProduct(typed(msg), d);
    expect(graphOf(d)[0].payload).not.toHaveProperty("fast_edit");
  });

  it("site_edit_auto_route off, or unreadable: the full pass, as before", async () => {
    for (const resolve of [vi.fn().mockResolvedValue(false), vi.fn().mockRejectedValue(new Error("db down"))]) {
      const d = deps({ resolveSiteEditAutoRoute: resolve });
      await refineProduct(typed("make the call button green"), d);
      expect(graphOf(d)[0].payload).not.toHaveProperty("fast_edit");
      expect(graphOf(d)[0].estimate_usd).toBe(3.0);
    }
  });

  it("site_fast_edit_node off wins: a routed tweak runs the full prompt and is never escalated", async () => {
    const d = deps({ resolveSiteFastEditNode: vi.fn().mockResolvedValue(false) });
    await refineProduct(typed("make the call button green"), d);
    const [engineer] = graphOf(d);
    expect(engineer.payload).not.toHaveProperty("fast_edit");
    expect(engineer.payload).not.toHaveProperty("edit_routed");
  });

  it("an inline Apply keeps its caller flag and is never marked as routed", async () => {
    const d = deps();
    await refineProduct(typed("Apply these exact edits the founder made: add a new page", { small_edit: true }), d);
    const [engineer] = graphOf(d);
    expect(engineer.payload).toMatchObject({ fast_edit: true, edit_size: "tweak" });
    expect(engineer.payload).not.toHaveProperty("edit_routed");
    expect(d.resolveSiteEditAutoRoute).not.toHaveBeenCalled();
  });
});
