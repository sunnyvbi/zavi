
import { describe, it, expect, vi, type Mock } from "vitest";
import {
  refineProduct,
  FreeEditsUsed,
  FREE_EDITS_LIMIT,
  type FreeEditState,
  type RefineProductDeps,
  type PriorRefineTurn,
} from "@/services/agents/refine-product";
import {
  InsufficientCreditsForBuild,
  requiredRefineCredits,
  type BalanceState,
} from "@/services/agents/build-credit-preflight";
import type { ProvisionedTarget } from "@/services/agents/autopilot-pipeline-contract";
import { testSite } from "./fixtures/refine-site";

const TARGET: ProvisionedTarget = {
  repo_url: "https://github.com/praxis-build/acme",
  github_full_name: "praxis-build/acme",
  default_branch: "main",
};

const free = (used: number, over: Partial<FreeEditState> = {}): FreeEditState => ({
  applies: true,
  used,
  limit: FREE_EDITS_LIMIT,
  retry_waived: false,
  ...over,
});
const PAID: FreeEditState = { applies: false, used: 0, limit: FREE_EDITS_LIMIT, retry_waived: false };
const wallet = (remaining: number): BalanceState => ({ remaining, enforced: true, unlimited: false, free_plan: false });

type MockDeps = RefineProductDeps & { [K in keyof RefineProductDeps]-?: Mock };
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
    loadAppPolicy: vi.fn().mockResolvedValue({ protected_globs: [], freeze: false, preview: "branch_preview" }),
    loadFreeEditState: vi.fn().mockResolvedValue(PAID),
    claimFreeEdit: vi.fn().mockResolvedValue(true),
    readBalance: vi.fn().mockResolvedValue(wallet(0)),
    ...over,
  };
  return base as unknown as MockDeps;
}

const BASE = { tenant_id: "t1", message: "make the header sticky in the top corner" };

describe("Free tenant: two free edits, then an upfront upgrade ask", () => {
  it.each([0, 1])("refine with %i used is claimed free; the wallet is never checked", async (used) => {
    const d = deps({ loadFreeEditState: vi.fn().mockResolvedValue(free(used)) });
    const r = await refineProduct(BASE, d);
    expect(r.conductor_run_id).toBe("cr_1");
    expect(d.claimFreeEdit).toHaveBeenCalledWith("t1", "cr_1", null);
    expect(d.claimFreeEdit.mock.invocationCallOrder[0]).toBeLessThan(
      d.updateConductorRunStatus.mock.invocationCallOrder[0],
    );
    expect(d.updateConductorRunStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
    expect(d.readBalance).not.toHaveBeenCalled();
  });

  it("3rd refine with bought credits that cover it → runs and is charged (never claimed free)", async () => {
    const d = deps({
      loadFreeEditState: vi.fn().mockResolvedValue(free(2)),
      readBalance: vi.fn().mockResolvedValue({ ...wallet(requiredRefineCredits()), free_plan: false }),
    });
    const r = await refineProduct(BASE, d);
    expect(r.conductor_run_id).toBe("cr_1");
    expect(d.readBalance).toHaveBeenCalledWith("t1");
    expect(d.claimFreeEdit).not.toHaveBeenCalled();
    expect(d.updateConductorRunStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
  });

  it("3rd refine the wallet cannot cover → FreeEditsUsed (402 free_edits_used) before any slot or conductor row", async () => {
    const d = deps({
      loadFreeEditState: vi.fn().mockResolvedValue(free(2)),
      readBalance: vi.fn().mockResolvedValue({ ...wallet(requiredRefineCredits() - 1), free_plan: true }),
    });
    const err = await refineProduct(BASE, d).catch((e) => e);
    expect(err).toBeInstanceOf(FreeEditsUsed);
    expect((err as Error).message).toBe("You've used your 2 free edits. Editing your app needs Starter ($20/mo), or buy credits.");
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    expect(d.updateConductorRunStatus).not.toHaveBeenCalled();
    expect(d.claimFreeEdit).not.toHaveBeenCalled();
  });

  it.each([
    ["an unreadable balance (null)", vi.fn().mockResolvedValue(null)],
    ["a balance read that throws", vi.fn().mockRejectedValue(new Error("db blip"))],
  ])("3rd refine with %s fails closed: FreeEditsUsed before any slot", async (_label, readBalance) => {
    const d = deps({ loadFreeEditState: vi.fn().mockResolvedValue(free(2)), readBalance });
    await expect(refineProduct(BASE, d)).rejects.toBeInstanceOf(FreeEditsUsed);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });

  it("a retry of a failed free edit stays free even with none left, and the retry id reaches the claim", async () => {
    const d = deps({ loadFreeEditState: vi.fn().mockResolvedValue(free(2, { retry_waived: true })) });
    await refineProduct({ ...BASE, retry_of: "11111111-1111-4111-8111-111111111111" }, d);
    expect(d.loadFreeEditState).toHaveBeenCalledWith("t1", "11111111-1111-4111-8111-111111111111");
    expect(d.claimFreeEdit).toHaveBeenCalledWith("t1", "cr_1", "11111111-1111-4111-8111-111111111111");
  });

  it("a double-click that loses the claim (slot serialises it) is refused and releases the slot", async () => {
    const d = deps({
      loadFreeEditState: vi.fn().mockResolvedValue(free(1)),
      claimFreeEdit: vi.fn().mockResolvedValue(false),
    });
    await expect(refineProduct(BASE, d)).rejects.toBeInstanceOf(FreeEditsUsed);
    expect(d.updateConductorRunStatus).toHaveBeenCalledTimes(1);
    expect(d.updateConductorRunStatus).toHaveBeenCalledWith({ conductor_run_id: "cr_1", status: "failed" });
  });
});

describe("paid tenant: the refine credit pre-flight", () => {
  it("short on credits → InsufficientCreditsForBuild (change) upfront: no slot, no row", async () => {
    const d = deps({ readBalance: vi.fn().mockResolvedValue(wallet(requiredRefineCredits() - 1)) });
    const err = await refineProduct(BASE, d).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientCreditsForBuild);
    expect((err as InsufficientCreditsForBuild).scope).toBe("change");
    expect((err as InsufficientCreditsForBuild).required_credits).toBe(requiredRefineCredits());
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    expect(d.updateConductorRunStatus).not.toHaveBeenCalled();
  });

  it("with credits → unchanged: slot taken, row activated, never a free edit", async () => {
    const d = deps({ readBalance: vi.fn().mockResolvedValue(wallet(requiredRefineCredits())) });
    const r = await refineProduct(BASE, d);
    expect(r.conductor_run_id).toBe("cr_1");
    expect(d.tryAcquireBuildSlot).toHaveBeenCalledTimes(1);
    expect(d.claimFreeEdit).not.toHaveBeenCalled();
    expect(d.updateConductorRunStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
  });

  it("an unlimited or not-enforced wallet is never refused", async () => {
    for (const s of [
      { remaining: 0, enforced: true, unlimited: true },
      { remaining: 0, enforced: false, unlimited: false },
    ]) {
      const d = deps({ readBalance: vi.fn().mockResolvedValue(s) });
      await expect(refineProduct(BASE, d)).resolves.toMatchObject({ conductor_run_id: "cr_1" });
    }
  });

  it("an unreadable free-edit state is not a free pass: the wallet decides", async () => {
    const d = deps({
      loadFreeEditState: vi.fn().mockRejectedValue(new Error("rpc blip")),
      readBalance: vi.fn().mockResolvedValue({ ...wallet(10), free_plan: true }),
    });
    const err = await refineProduct(BASE, d).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientCreditsForBuild);
    expect((err as InsufficientCreditsForBuild).free_plan).toBe(true);
    expect(d.claimFreeEdit).not.toHaveBeenCalled();
  });
});
