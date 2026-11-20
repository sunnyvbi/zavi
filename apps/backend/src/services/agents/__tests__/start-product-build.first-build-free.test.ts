
import { describe, it, expect, vi } from "vitest";
import { startProductBuild, type StartProductBuildDeps } from "@/services/agents/start-product-build";
import { InsufficientCreditsForBuild } from "@/services/agents/build-credit-preflight";
import type { FastBuildContext } from "@/services/sites/contract";

function deps(over: Partial<StartProductBuildDeps> = {}) {
  return {
    checkSitePrereqs: vi.fn().mockResolvedValue({ ok: true }),
    startFastBuild: vi.fn(async (ctx: FastBuildContext) => ({
      kind: "started" as const,
      result: {
        conductor_run_id: ctx.conductor_run_id,
        provision: { provisioned: ["repo" as const], connected: [], pending_creds: [], failed: [], context: {} },
        target: { github_full_name: "praxis-build/acme", default_branch: "main" },
        first_build_free: ctx.first_build_free,
      },
    })),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_1"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    assertBuildCredits: vi
      .fn()
      .mockRejectedValue(new InsufficientCreditsForBuild(6_500, 1_000)),
    isFirstBuildFree: vi.fn().mockResolvedValue(true),
    claimFirstFreeBuild: vi.fn().mockResolvedValue(true),
    ...over,
  } satisfies StartProductBuildDeps;
}

const BASE = { tenant_id: "t1", company_name: "Acme Corp", idea: "A marketplace for designers" };

describe("startProductBuild — first Build free", () => {
  it("first Build starts on a wallet the pre-flight would refuse, and claims the waiver", async () => {
    const d = deps();
    const result = await startProductBuild(BASE, d);
    expect(result.first_build_free).toBe(true);
    expect(d.assertBuildCredits).not.toHaveBeenCalled();
    expect(d.claimFirstFreeBuild).toHaveBeenCalledWith("t1", "cr_1");
    expect(d.startFastBuild).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.startFastBuild).mock.calls[0][0]).toMatchObject({ first_build_free: true });
  });

  it("a later Build pays: the pre-flight runs and refuses before any slot or site", async () => {
    const d = deps({ isFirstBuildFree: vi.fn().mockResolvedValue(false) });
    await expect(startProductBuild(BASE, d)).rejects.toBeInstanceOf(InsufficientCreditsForBuild);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    expect(d.claimFirstFreeBuild).not.toHaveBeenCalled();
    expect(d.startFastBuild).not.toHaveBeenCalled();
  });

  it("a later Build with enough credits runs and is not marked free", async () => {
    const d = deps({
      isFirstBuildFree: vi.fn().mockResolvedValue(false),
      assertBuildCredits: vi.fn().mockResolvedValue(undefined),
    });
    const result = await startProductBuild(BASE, d);
    expect(result.first_build_free).toBe(false);
    expect(d.claimFirstFreeBuild).not.toHaveBeenCalled();
  });

  it("a lost claim falls back to the pre-flight and releases the slot, with no site", async () => {
    const d = deps({ claimFirstFreeBuild: vi.fn().mockResolvedValue(false) });
    await expect(startProductBuild(BASE, d)).rejects.toBeInstanceOf(InsufficientCreditsForBuild);
    expect(d.assertBuildCredits).toHaveBeenCalledTimes(1);
    expect(d.startFastBuild).not.toHaveBeenCalled();
    expect(d.updateConductorRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({ conductor_run_id: "cr_1", status: "failed" }),
    );
  });

  it("a claim that errors keeps the site the workspace's first, so it still goes live; a lost claim does not", async () => {
    const errored = deps({ claimFirstFreeBuild: vi.fn().mockRejectedValue(new Error("db down")), assertBuildCredits: vi.fn().mockResolvedValue(undefined) });
    await startProductBuild(BASE, errored);
    expect(vi.mocked(errored.startFastBuild).mock.calls[0][0]).toMatchObject({ first_build_free: false, first_site: true });
    const lost = deps({ claimFirstFreeBuild: vi.fn().mockResolvedValue(false), assertBuildCredits: vi.fn().mockResolvedValue(undefined) });
    await startProductBuild(BASE, lost);
    expect(vi.mocked(lost.startFastBuild).mock.calls[0][0]).not.toHaveProperty("first_site");
  });

  it("an eligibility read error is unknown: the claim decides, a won claim builds free", async () => {
    const d = deps({ isFirstBuildFree: vi.fn().mockRejectedValue(new Error("db down")) });
    const result = await startProductBuild(BASE, d);
    expect(result.first_build_free).toBe(true);
    expect(d.claimFirstFreeBuild).toHaveBeenCalledWith("t1", "cr_1");
    expect(d.assertBuildCredits).not.toHaveBeenCalled();
  });

  it("an eligibility read error with a lost claim still runs the credit floor, with no site", async () => {
    const d = deps({
      isFirstBuildFree: vi.fn().mockRejectedValue(new Error("db down")),
      claimFirstFreeBuild: vi.fn().mockResolvedValue(false),
    });
    await expect(startProductBuild(BASE, d)).rejects.toBeInstanceOf(InsufficientCreditsForBuild);
    expect(d.assertBuildCredits).toHaveBeenCalledTimes(1);
    expect(d.startFastBuild).not.toHaveBeenCalled();
  });

  it("an eligibility read error never blocks a tenant the floor admits", async () => {
    const d = deps({
      isFirstBuildFree: vi.fn().mockRejectedValue(new Error("db down")),
      claimFirstFreeBuild: vi.fn().mockResolvedValue(false),
      assertBuildCredits: vi.fn().mockResolvedValue(undefined),
    });
    const result = await startProductBuild(BASE, d);
    expect(result.first_build_free).toBe(false);
    expect(d.startFastBuild).toHaveBeenCalledTimes(1);
  });
});
