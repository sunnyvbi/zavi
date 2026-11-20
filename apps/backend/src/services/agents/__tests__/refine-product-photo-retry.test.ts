import { describe, it, expect, vi, type Mock } from "vitest";
import { refineProduct, PhotoRetryTaken, FREE_EDITS_LIMIT, type RefineProductDeps, type PriorRefineTurn } from "@/services/agents/refine-product";
import { InsufficientCreditsForBuild, requiredRefineCredits, type BalanceState } from "@/services/agents/build-credit-preflight";
import { PHOTO_RETRY_MESSAGE } from "@/services/sites/site-photos";
import { testSite } from "./fixtures/refine-site";

const wallet = (remaining: number): BalanceState => ({ remaining, enforced: true, unlimited: false, free_plan: false });
const PAID = { applies: false, used: 0, limit: FREE_EDITS_LIMIT, retry_waived: false };

type MockDeps = RefineProductDeps & { [K in keyof RefineProductDeps]-?: Mock };
function deps(over: Partial<RefineProductDeps> = {}): MockDeps {
  return {
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
    photoRetryFree: vi.fn().mockResolvedValue(true),
    claimPhotoRetry: vi.fn().mockResolvedValue(true),
    ...over,
  } as unknown as MockDeps;
}

const RETRY = { tenant_id: "t1", message: PHOTO_RETRY_MESSAGE, photo_retry: true };
const site = () => testSite({ tenant_id: "t1" });

describe("the photo Retry", () => {
  it("the first one per site is free: no wallet, no free edit used, claimed on this tenant's site before the row goes active", async () => {
    const d = deps();
    const r = await refineProduct(RETRY, d);
    expect(r.conductor_run_id).toBe("cr_1");
    expect(d.photoRetryFree).toHaveBeenCalledWith("t1", site().id);
    expect(d.claimPhotoRetry).toHaveBeenCalledWith("t1", site().id, "cr_1");
    expect(d.claimPhotoRetry.mock.invocationCallOrder[0]).toBeLessThan(d.updateConductorRunStatus.mock.invocationCallOrder[0]);
    expect(d.readBalance).not.toHaveBeenCalled();
    expect(d.loadFreeEditState).not.toHaveBeenCalled();
    expect(d.claimFreeEdit).not.toHaveBeenCalled();
    const graph = d.updateConductorRunStatus.mock.calls.find((c) => c[0].status === "active")![0].goal_graph;
    expect(graph[0].payload).toMatchObject({ photo_retry: true, site_id: site().id, refine_mode: true });
  });

  it("a second one is a normal paid edit: the wallet decides, nothing is waived", async () => {
    const short = deps({ photoRetryFree: vi.fn().mockResolvedValue(false) });
    await expect(refineProduct(RETRY, short)).rejects.toBeInstanceOf(InsufficientCreditsForBuild);
    expect(short.tryAcquireBuildSlot).not.toHaveBeenCalled();
    expect(short.claimPhotoRetry).not.toHaveBeenCalled();

    const paid = deps({ photoRetryFree: vi.fn().mockResolvedValue(false), readBalance: vi.fn().mockResolvedValue(wallet(requiredRefineCredits())) });
    expect((await refineProduct(RETRY, paid)).conductor_run_id).toBe("cr_1");
    expect(paid.claimPhotoRetry).not.toHaveBeenCalled();
  });

  it("a later retry on a Free tenant with free edits left is still paid: it never rides a free edit", async () => {
    const d = deps({
      photoRetryFree: vi.fn().mockResolvedValue(false),
      loadFreeEditState: vi.fn().mockResolvedValue({ applies: true, used: 0, limit: FREE_EDITS_LIMIT, retry_waived: false }),
      readBalance: vi.fn().mockResolvedValue({ ...wallet(requiredRefineCredits()), free_plan: true }),
    });
    await refineProduct(RETRY, d);
    expect(d.claimFreeEdit).not.toHaveBeenCalled();
    expect(d.claimPhotoRetry).not.toHaveBeenCalled();
    expect(d.readBalance).toHaveBeenCalled();
  });

  it("an unreadable free state is never a free pass", async () => {
    const d = deps({ photoRetryFree: vi.fn().mockRejectedValue(new Error("db blip")) });
    await expect(refineProduct(RETRY, d)).rejects.toBeInstanceOf(InsufficientCreditsForBuild);
    expect(d.claimPhotoRetry).not.toHaveBeenCalled();
  });

  it("a double click that loses the claim is refused and the row is failed (nothing runs free twice)", async () => {
    const d = deps({ claimPhotoRetry: vi.fn().mockResolvedValue(false) });
    await expect(refineProduct(RETRY, d)).rejects.toBeInstanceOf(PhotoRetryTaken);
    expect(d.updateConductorRunStatus).toHaveBeenCalledWith({ conductor_run_id: "cr_1", status: "failed" });
  });

  it("a normal edit never asks for or claims the photo retry", async () => {
    const d = deps({ readBalance: vi.fn().mockResolvedValue(wallet(requiredRefineCredits())) });
    await refineProduct({ tenant_id: "t1", message: "make the header sticky in the top corner" }, d);
    expect(d.photoRetryFree).not.toHaveBeenCalled();
    expect(d.claimPhotoRetry).not.toHaveBeenCalled();
  });

  it("only the caller's own site is ever named: another tenant's site is not a target", async () => {
    const d = deps({ listSites: vi.fn().mockResolvedValue([testSite({ tenant_id: "t2" })]) });
    await expect(refineProduct(RETRY, d)).rejects.toThrow();
    expect(d.claimPhotoRetry).not.toHaveBeenCalled();
  });
});
