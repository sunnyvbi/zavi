import { describe, it, expect, vi } from "vitest";
import { startProductBuild, startProductBuildDetached, type StartProductBuildDeps } from "@/services/agents/start-product-build";
import { InsufficientCreditsForBuild } from "@/services/agents/build-credit-preflight";
import { siteSetupMarker } from "@/services/agents/site-setup-marker";
import type { FastBuildContext } from "@/services/sites/contract";

const started = (ctx: FastBuildContext) => ({
  kind: "started" as const,
  result: {
    conductor_run_id: ctx.conductor_run_id,
    provision: { provisioned: ["repo" as const], connected: [], pending_creds: [], failed: [], context: {} },
    target: { github_full_name: "praxis-build/acme", default_branch: "main" },
    first_build_free: ctx.first_build_free,
  },
});

function deps(over: Partial<StartProductBuildDeps> = {}) {
  return {
    checkSitePrereqs: vi.fn().mockResolvedValue({ ok: true }),
    startFastBuild: vi.fn(async (ctx: FastBuildContext) => started(ctx)),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_1"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    assertBuildCredits: vi.fn().mockRejectedValue(new InsufficientCreditsForBuild(6_500, 1_000)),
    isFirstBuildFree: vi.fn().mockResolvedValue(true),
    claimFirstFreeBuild: vi.fn().mockResolvedValue(true),
    ...over,
  } satisfies StartProductBuildDeps;
}

const BASE = { tenant_id: "t1", company_name: "Acme Corp", idea: "A marketplace for designers" };
const forever = () => new Promise<never>(() => {});

describe("startProductBuildDetached", () => {
  it("answers with the run while the saga and the site name are still pending", async () => {
    const d = deps({ startFastBuild: vi.fn(forever), resolveSiteName: vi.fn(forever) });
    const out = await startProductBuildDetached(BASE, d);
    expect(out.conductor_run_id).toBe("cr_1");
    expect(d.claimFirstFreeBuild).toHaveBeenCalledTimes(1);
  });

  it("the run id is stamped before the answer, so a retry finds this run", async () => {
    const onRunCreated = vi.fn().mockResolvedValue(undefined);
    await startProductBuildDetached({ ...BASE, onRunCreated }, deps({ startFastBuild: vi.fn(forever) }));
    expect(onRunCreated).toHaveBeenCalledWith("cr_1");
  });

  it("a wallet refusal still throws to the caller, before any slot or site", async () => {
    const d = deps({ isFirstBuildFree: vi.fn().mockResolvedValue(false) });
    await expect(startProductBuildDetached(BASE, d)).rejects.toBeInstanceOf(InsufficientCreditsForBuild);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    expect(d.startFastBuild).not.toHaveBeenCalled();
  });

  it("a lost free claim still refuses to the caller and releases the slot, with no site", async () => {
    const d = deps({ claimFirstFreeBuild: vi.fn().mockResolvedValue(false) });
    await expect(startProductBuildDetached(BASE, d)).rejects.toBeInstanceOf(InsufficientCreditsForBuild);
    expect(d.updateConductorRunStatus).toHaveBeenCalledWith(expect.objectContaining({ conductor_run_id: "cr_1", status: "failed" }));
    expect(d.startFastBuild).not.toHaveBeenCalled();
  });

  it("a run the caller cannot record never starts a site, and frees the slot", async () => {
    const onRunCreated = vi.fn().mockRejectedValue(new Error("duplicate request"));
    const d = deps();
    await expect(startProductBuildDetached({ ...BASE, onRunCreated }, d)).rejects.toThrow("duplicate request");
    expect(d.claimFirstFreeBuild).not.toHaveBeenCalled();
    expect(d.startFastBuild).not.toHaveBeenCalled();
    expect(d.updateConductorRunStatus).toHaveBeenCalledWith(expect.objectContaining({ conductor_run_id: "cr_1", status: "failed" }));
  });

  it("a saga failure after the answer fails the run with a Retry marker that keeps the free build", async () => {
    const d = deps({
      startFastBuild: vi.fn(async () => ({ kind: "setup_failed" as const, reason: "repo down", retryable: true })),
    });
    const out = await startProductBuildDetached(BASE, d);
    await expect(out.setup).rejects.toThrow();
    const failed = vi.mocked(d.updateConductorRunStatus).mock.calls.at(-1)?.[0];
    expect(failed).toMatchObject({ conductor_run_id: "cr_1", status: "failed", failure_class: "provision_failed" });
    expect(siteSetupMarker(failed?.goal_graph)).toMatchObject({ retryable: true, first_build_free: true });
  });

  it("the saga runs exactly once and the free claim is never repeated", async () => {
    const d = deps();
    const out = await startProductBuildDetached(BASE, d);
    await out.setup;
    expect(d.startFastBuild).toHaveBeenCalledTimes(1);
    expect(d.claimFirstFreeBuild).toHaveBeenCalledTimes(1);
    expect(d.tryAcquireBuildSlot).toHaveBeenCalledTimes(1);
  });

  it("startProductBuild still waits for the saga", async () => {
    const d = deps();
    const r = await startProductBuild(BASE, d);
    expect(r.target.github_full_name).toBe("praxis-build/acme");
    expect(d.startFastBuild).toHaveBeenCalledTimes(1);
  });
});
