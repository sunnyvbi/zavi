import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastBuildContext } from "@/services/sites/contract";
import type { ResolveSummary } from "@/services/provisioning/resolve-resources";

const h = vi.hoisted(() => ({
  ownName: true as boolean | "throw",
  intake: vi.fn(async (_idea: string) => ({ company_name: null as string | null, what_we_sell: null })),
}));

vi.mock("@/services/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/settings")>();
  return {
    ...actual,
    getBoolSetting: vi.fn(async (key: string) => {
      if (key === "build_site_own_name") {
        if (h.ownName === "throw") throw new Error("settings down");
        return h.ownName;
      }
      throw new Error(`unexpected setting ${key}`);
    }),
  };
});

vi.mock("@/services/onboarding/idea-intake", () => ({ extractIdeaIntake: h.intake }));

import { realStartProductBuildDeps, startProductBuild, type StartProductBuildDeps } from "@/services/agents/start-product-build";

const IDEA = "I want a booking website for my dog grooming salon in Pune with online payments";
const BASE = { tenant_id: "t1", company_name: "Apna Tutor", idea: IDEA, started_by_user_id: "u1" };

function summary(): ResolveSummary {
  return { provisioned: ["repo"], connected: [], pending_creds: [], failed: [], context: { github_full_name: "praxis-built/x", repo_url: "https://github.com/praxis-built/x", default_branch: "main" } };
}

function deps(over: Partial<StartProductBuildDeps> = {}) {
  const fastCtx: FastBuildContext[] = [];
  const d: StartProductBuildDeps = {
    checkSitePrereqs: vi.fn().mockResolvedValue({ ok: true }),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_1"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    assertBuildCredits: vi.fn().mockResolvedValue(undefined),
    resolveOwnerEmail: vi.fn().mockResolvedValue(null),
    resolveWorkspaceName: vi.fn().mockResolvedValue("Apna Tutor"),
    startFastBuild: vi.fn(async (ctx: FastBuildContext) => {
      fastCtx.push(ctx);
      return {
        kind: "started" as const,
        result: { conductor_run_id: "cr_1", provision: summary(), target: {} },
      };
    }),
    resolveSiteName: realStartProductBuildDeps.resolveSiteName,
    ...over,
  };
  return { d, fastCtx };
}

beforeEach(() => {
  h.ownName = true;
  h.intake.mockReset();
  h.intake.mockResolvedValue({ company_name: null, what_we_sell: null });
});

describe("DEL-1323 B33/B24: a new site is named after its idea, not the workspace", () => {
  it("an in-app build in workspace 'Apna Tutor' names the site from the idea via the intake model", async () => {
    h.intake.mockResolvedValue({ company_name: "Paws and Suds", what_we_sell: null });
    const { d, fastCtx } = deps();
    await startProductBuild(BASE, d);
    expect(h.intake).toHaveBeenCalledWith(IDEA);
    expect(fastCtx[0].site_name).toBe("Paws and Suds");
    expect(fastCtx[0].company_name).toBe("Apna Tutor");
  });

  it("a name the caller already extracted (/start) is used as-is and the model is not called twice", async () => {
    const { d, fastCtx } = deps();
    await startProductBuild({ ...BASE, site_name: "Paws & Suds" }, d);
    expect(h.intake).not.toHaveBeenCalled();
    expect(fastCtx[0].site_name).toBe("Paws & Suds");
  });

  it("when the model has nothing, the idea's own words name the site, never the workspace", async () => {
    const { d, fastCtx } = deps();
    await startProductBuild(BASE, d);
    expect(fastCtx[0].site_name).toBe("Dog Grooming Salon");
    expect(fastCtx[0].workspace_name).toBe("Apna Tutor");
  });

  it("with build_site_own_name off the site is unnamed (named after the workspace, as before)", async () => {
    h.ownName = false;
    h.intake.mockResolvedValue({ company_name: "Paws and Suds", what_we_sell: null });
    const { d, fastCtx } = deps();
    await startProductBuild({ ...BASE, site_name: "Paws & Suds" }, d);
    expect(h.intake).not.toHaveBeenCalled();
    expect(fastCtx[0]).not.toHaveProperty("site_name");
  });

  it("an unreadable setting keeps naming on (the key's default)", async () => {
    h.ownName = "throw";
    h.intake.mockResolvedValue({ company_name: "Paws and Suds", what_we_sell: null });
    const { d, fastCtx } = deps();
    await startProductBuild(BASE, d);
    expect(fastCtx[0].site_name).toBe("Paws and Suds");
  });

  it("a naming failure never blocks the build", async () => {
    const { d, fastCtx } = deps({ resolveSiteName: vi.fn().mockRejectedValue(new Error("boom")) });
    const r = await startProductBuild(BASE, d);
    expect(r.conductor_run_id).toBe("cr_1");
    expect(fastCtx[0]).not.toHaveProperty("site_name");
  });

  it("a site setup failure titles the failed run after the site it was for", async () => {
    h.intake.mockResolvedValue({ company_name: "Paws and Suds", what_we_sell: null });
    const { d } = deps({ startFastBuild: vi.fn().mockResolvedValue({ kind: "setup_failed", reason: "repo: boom", retryable: true }) });
    await expect(startProductBuild(BASE, d)).rejects.toThrow(/couldn't set up your new site/);
    expect(d.updateConductorRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", objective: expect.stringContaining("Paws and Suds") }),
    );
  });
});
