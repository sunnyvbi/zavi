
import { describe, it, expect, vi, type Mock } from "vitest";
import {
  refineProduct,
  assertRefineAllowed,
  FleetHalted,
  AppFrozen,
  type RefineProductDeps,
  type PriorRefineTurn,
} from "@/services/agents/refine-product";
import type { ProvisionedTarget } from "@/services/agents/autopilot-pipeline-contract";
import { testSite } from "./fixtures/refine-site";

const TARGET: ProvisionedTarget = {
  repo_url: "https://github.com/praxis-build/acme",
  github_full_name: "praxis-build/acme",
  default_branch: "main",
};

type MockDeps = RefineProductDeps & { [K in keyof RefineProductDeps]: Mock };
function deps(over: Partial<RefineProductDeps> = {}): MockDeps {
  const base = {
    loadProvisionedTarget: vi.fn().mockResolvedValue(null),
    loadPriorRefines: vi.fn().mockResolvedValue([] as PriorRefineTurn[]),
    verifyConductorRunOwnership: vi.fn().mockResolvedValue(true),
    listSites: vi.fn().mockResolvedValue([testSite({ tenant_id: "t1" })]),
    loadConductorRunKind: vi.fn().mockResolvedValue("build_app"),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_1"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    loadRepoHeadSha: vi.fn().mockResolvedValue(null),
    resolveRefineDirectMergeEnabled: vi.fn().mockResolvedValue(false),
    isFleetHalted: vi.fn().mockResolvedValue(false),
    loadAppPolicy: vi
      .fn()
      .mockResolvedValue({ protected_globs: [], freeze: false, preview: "branch_preview" }),
    ...over,
  };
  return base as unknown as MockDeps;
}

const BASE = { tenant_id: "t1", message: "make the header sticky in the top corner" };

describe("refineProduct front door — global fleet halt (Q10, fail-closed)", () => {
  it("is_fleet_halted=true → FleetHalted, NO slot acquired, NO row created", async () => {
    const d = deps({ isFleetHalted: vi.fn().mockResolvedValue(true) });
    await expect(refineProduct(BASE, d)).rejects.toBeInstanceOf(FleetHalted);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    expect(d.updateConductorRunStatus).not.toHaveBeenCalled();
  });

  it("is_fleet_halted read THROWS → FleetHalted (fail-CLOSED)", async () => {
    const d = deps({ isFleetHalted: vi.fn().mockRejectedValue(new Error("rpc blip")) });
    await expect(refineProduct(BASE, d)).rejects.toBeInstanceOf(FleetHalted);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });
});

describe("refineProduct front door — per-app freeze (Q8)", () => {
  it("freeze=true → AppFrozen, rejected BEFORE tryAcquireBuildSlot", async () => {
    const d = deps({
      loadAppPolicy: vi
        .fn()
        .mockResolvedValue({ protected_globs: [], freeze: true, preview: "branch_preview" }),
    });
    await expect(refineProduct(BASE, d)).rejects.toBeInstanceOf(AppFrozen);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    expect(d.updateConductorRunStatus).not.toHaveBeenCalled();
  });

  it("policy read THROWS → fail-OPEN (not frozen): refine PROCEEDS", async () => {
    const d = deps({ loadAppPolicy: vi.fn().mockRejectedValue(new Error("policy blip")) });
    const r = await refineProduct(BASE, d);
    expect(r.conductor_run_id).toBe("cr_1");
    expect(d.tryAcquireBuildSlot).toHaveBeenCalledTimes(1);
  });
});

describe("refineProduct front door — clean (not halted/frozen) is unchanged", () => {
  it("proceeds: slot acquired + conductor row flipped active", async () => {
    const d = deps();
    const r = await refineProduct(BASE, d);
    expect(r.conductor_run_id).toBe("cr_1");
    expect(d.tryAcquireBuildSlot).toHaveBeenCalledTimes(1);
    expect(d.updateConductorRunStatus).toHaveBeenCalled();
  });
});

describe("assertRefineAllowed — reusable front-door helper (suggestion-accept path)", () => {
  it("throws FleetHalted before any state work when halted", async () => {
    const d = deps({ isFleetHalted: vi.fn().mockResolvedValue(true) });
    await expect(assertRefineAllowed("t1", d)).rejects.toBeInstanceOf(FleetHalted);
  });
  it("throws AppFrozen when frozen", async () => {
    const d = deps({
      loadAppPolicy: vi
        .fn()
        .mockResolvedValue({ protected_globs: [], freeze: true, preview: "branch_preview" }),
    });
    await expect(assertRefineAllowed("t1", d)).rejects.toBeInstanceOf(AppFrozen);
  });
  it("resolves when not halted + not frozen", async () => {
    await expect(assertRefineAllowed("t1", deps())).resolves.toBeUndefined();
  });
});
