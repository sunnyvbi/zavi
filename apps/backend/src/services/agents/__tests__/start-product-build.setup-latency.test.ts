import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startProductBuild,
  retrySiteSetup,
  DoubleBuildInFlight,
  type FastBuildOutcome,
  type StartProductBuildDeps,
} from "@/services/agents/start-product-build";
import { InsufficientCreditsForBuild } from "@/services/agents/build-credit-preflight";
import { SITE_SETUP_MARKER_KEY } from "@/services/agents/site-setup-marker";
import type { FastBuildContext } from "@/services/sites/contract";

const SITE = "00000000-0000-4000-8000-0000000000aa";
const IDEA = "A booking site for Priya's dog grooming salon";
const BASE = { tenant_id: "t1", company_name: "Acme Corp", idea: IDEA, started_by_user_id: "u1" };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

function started(ctx: FastBuildContext, timing?: { brief_ms: number; repo_ms: number; seed_ms: number }): FastBuildOutcome {
  return {
    kind: "started",
    result: {
      conductor_run_id: ctx.conductor_run_id,
      provision: { provisioned: ["repo"], connected: [], pending_creds: [], failed: [], context: { site_id: SITE } },
      target: { github_full_name: "praxis-built/acme-1", default_branch: "main", github_target_mode: "umbrella" },
      first_build_free: ctx.first_build_free,
    },
    ...(timing ? { timing } : {}),
  };
}

function deps(over: Partial<StartProductBuildDeps> = {}) {
  const d = {
    checkSitePrereqs: vi.fn(async () => ({ ok: true as const })),
    startFastBuild: vi.fn(async (ctx: FastBuildContext) => started(ctx)),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_1"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    cancelConductorRun: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    assertBuildCredits: vi.fn().mockResolvedValue(undefined),
    resolveOwnerEmail: vi.fn().mockResolvedValue("owner@example.com"),
    resolveWorkspaceName: vi.fn().mockResolvedValue("Acme Workspace"),
    resolveSiteName: vi.fn().mockResolvedValue("Paws and Suds"),
    claimSiteSetupRetry: vi.fn().mockResolvedValue("resumed"),
    ...over,
  };
  return d as typeof d & StartProductBuildDeps;
}

let unhandled: unknown[];
const onUnhandled = (e: unknown) => {
  unhandled.push(e);
};

beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
});

describe("startProductBuild: setup reads run alongside the preflights and the slot", () => {
  it("reads the workspace name and owner email during the preflights, and asks the intake model only once the preflights pass, alongside the slot", async () => {
    const prereqs = deferred<{ ok: true }>();
    const slot = deferred<string>();
    const d = deps({ checkSitePrereqs: vi.fn(() => prereqs.promise), tryAcquireBuildSlot: vi.fn(() => slot.promise) });
    const run = startProductBuild(BASE, d);
    await flush();
    expect(d.resolveWorkspaceName).toHaveBeenCalledWith("t1");
    expect(d.resolveOwnerEmail).toHaveBeenCalledWith("t1", "u1");
    expect(d.resolveSiteName).not.toHaveBeenCalled();
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    prereqs.resolve({ ok: true });
    await flush();
    expect(d.tryAcquireBuildSlot).toHaveBeenCalledTimes(1);
    expect(d.resolveSiteName).toHaveBeenCalledWith({ tenant_id: "t1", idea: IDEA, company_name: "Acme Corp", workspace_name: "Acme Workspace", site_name: null });
    expect(d.startFastBuild).not.toHaveBeenCalled();
    slot.resolve("cr_1");
    await run;
    expect(d.startFastBuild).toHaveBeenCalledWith(
      expect.objectContaining({ conductor_run_id: "cr_1", workspace_name: "Acme Workspace", site_name: "Paws and Suds", owner_email: "owner@example.com" }),
    );
    expect(d.resolveWorkspaceName).toHaveBeenCalledTimes(1);
    expect(d.resolveOwnerEmail).toHaveBeenCalledTimes(1);
    expect(d.resolveSiteName).toHaveBeenCalledTimes(1);
  });

  it("the run is recorded before the build starts even when the intake answer arrives first", async () => {
    const order: string[] = [];
    const record = deferred<void>();
    const d = deps({
      resolveSiteName: vi.fn(async () => {
        order.push("named");
        return "Paws and Suds";
      }),
      startFastBuild: vi.fn(async (ctx: FastBuildContext) => {
        order.push("build");
        return started(ctx);
      }),
    });
    const run = startProductBuild({ ...BASE, onRunCreated: async () => { order.push("record:start"); await record.promise; order.push("recorded"); } }, d);
    await flush();
    expect(order).toEqual(["named", "record:start"]);
    record.resolve();
    await run;
    expect(order).toEqual(["named", "record:start", "recorded", "build"]);
  });

  it("a build refused by a preflight spends no model call, takes no slot, and leaves no unhandled rejection from the early reads", async () => {
    const d = deps({
      assertBuildCredits: vi.fn().mockRejectedValue(new InsufficientCreditsForBuild(2000, 0)),
      resolveOwnerEmail: vi.fn().mockRejectedValue(new Error("auth down")),
      resolveWorkspaceName: vi.fn().mockRejectedValue(new Error("db down")),
    });
    await expect(startProductBuild(BASE, d)).rejects.toBeInstanceOf(InsufficientCreditsForBuild);
    await flush(10);
    expect(d.resolveSiteName).not.toHaveBeenCalled();
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    expect(d.startFastBuild).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it("a build refused at the slot discards the in-flight intake answer: no saga, no run write, no unhandled rejection when the model fails later", async () => {
    const intake = deferred<string | null>();
    const d = deps({
      tryAcquireBuildSlot: vi.fn().mockRejectedValue(new DoubleBuildInFlight("t1")),
      resolveSiteName: vi.fn(() => intake.promise),
    });
    await expect(startProductBuild(BASE, d)).rejects.toBeInstanceOf(DoubleBuildInFlight);
    expect(d.resolveSiteName).toHaveBeenCalledTimes(1);
    intake.reject(new Error("model down"));
    await flush(10);
    expect(d.startFastBuild).not.toHaveBeenCalled();
    expect(d.updateConductorRunStatus).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it("failed early reads keep today's answers: no workspace name, a null owner email, and the model still names the site", async () => {
    const d = deps({
      resolveOwnerEmail: vi.fn().mockRejectedValue(new Error("auth down")),
      resolveWorkspaceName: vi.fn().mockRejectedValue(new Error("db down")),
      resolveSiteName: vi.fn().mockRejectedValue(new Error("model down")),
    });
    await startProductBuild(BASE, d);
    expect(d.resolveSiteName).toHaveBeenCalledWith(expect.objectContaining({ workspace_name: null }));
    expect(d.startFastBuild).toHaveBeenCalledWith(expect.objectContaining({ workspace_name: null, owner_email: null }));
    expect(vi.mocked(d.startFastBuild).mock.calls[0][0]).not.toHaveProperty("site_name");
    await flush();
    expect(unhandled).toEqual([]);
  });
});

describe("startProductBuild: one timing line per started setup", () => {
  function timingLines(spy: { mock: { calls: unknown[][] } }) {
    return spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[fast-build] timing"));
  }

  it("logs slot, intake, brief, repo, seed and total milliseconds with ids only, never the founder's text or email", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const d = deps({
      tryAcquireBuildSlot: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return "cr_1";
      }),
      resolveSiteName: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 30));
        return "Paws and Suds";
      }),
      startFastBuild: vi.fn(async (ctx: FastBuildContext) => started(ctx, { brief_ms: 1234, repo_ms: 2345, seed_ms: 3456 })),
    });
    await startProductBuild(BASE, d);
    const lines = timingLines(info);
    expect(lines).toHaveLength(1);
    const m = lines[0].match(
      /^\[fast-build\] timing tenant=t1 site=00000000-0000-4000-8000-0000000000aa slot_ms=(\d+) intake_ms=(\d+) brief_ms=1234 repo_ms=2345 seed_ms=3456 total_ms=(\d+)$/,
    );
    expect(m).not.toBeNull();
    const [slot, intake, total] = [Number(m![1]), Number(m![2]), Number(m![3])];
    expect(slot).toBeGreaterThanOrEqual(15);
    expect(intake).toBeGreaterThanOrEqual(25);
    expect(total).toBeGreaterThanOrEqual(Math.max(slot, intake));
    for (const secret of ["Priya", "grooming", "owner@example.com", "Acme", "Paws"]) expect(lines[0]).not.toContain(secret);
  });

  it("a failed setup logs no timing line", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const d = deps({ startFastBuild: vi.fn(async () => ({ kind: "setup_failed" as const, reason: "provisioning_failed:repo", retryable: true })) });
    await expect(startProductBuild(BASE, d)).rejects.toThrow();
    expect(timingLines(info)).toEqual([]);
  });

  it("a Retry logs its own timing line with no slot or intake step", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const setup = {
      v: 1,
      retryable: true,
      company_name: "Acme Corp",
      idea: IDEA,
      max_usd: 50,
      site_name: "Paws and Suds",
      workspace_name: null,
      started_by_user_id: "u1",
      first_build_free: false,
      reference_images: [],
    };
    const row = {
      id: "cr_1",
      updated_at: "2026-10-06T00:00:00Z",
      goal_graph: [{ id: "provision", status: "failed", payload: { stage: "provision", site_id: SITE, [SITE_SETUP_MARKER_KEY]: setup } }],
    };
    const d = deps({ startFastBuild: vi.fn(async (ctx: FastBuildContext) => started(ctx, { brief_ms: 1, repo_ms: 2, seed_ms: 3 })) });
    expect(await retrySiteSetup("t1", row, d)).toEqual({ ok: true, run_id: "cr_1" });
    const lines = timingLines(info);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[fast-build\] timing tenant=t1 site=\S+ slot_ms=na intake_ms=na brief_ms=1 repo_ms=2 seed_ms=3 total_ms=\d+$/);
  });
});
