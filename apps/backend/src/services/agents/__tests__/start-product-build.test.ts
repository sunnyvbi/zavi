
import { describe, it, expect, vi } from "vitest";
import {
  startProductBuild,
  retrySiteSetup,
  DEFAULT_PRODUCT_BUILD_MAX_USD,
  MAX_PRODUCT_BUILD_MAX_USD,
  MAX_PRODUCT_BUILDS_PER_DAY,
  ProvisionBudgetExceeded,
  DoubleBuildInFlight,
  TooManyBuildsToday,
  InvalidCompanyName,
  BuildRepoNotProvisioned,
  SiteSetupUnavailable,
  SiteBackendUnavailable,
  SITE_BACKEND_UNAVAILABLE_CODE,
  SITE_SETUP_UNAVAILABLE_COPY,
  buildSetupFailedBody,
  type FastBuildOutcome,
  type StartProductBuildDeps,
} from "@/services/agents/start-product-build";
import { DEFAULT_FAST_BUILD_ESTIMATE_USD } from "@/services/agents/fast-build";
import { siteSetupMarker, siteSetupRetryable } from "@/services/agents/site-setup-marker";
import { founderFailureView, founderStageError, summarizeBuildFailure } from "@/services/agents/build-failure";
import { InsufficientCreditsForBuild } from "@/services/agents/build-credit-preflight";
import type { FastBuildContext } from "@/services/sites/contract";
import type { ConductorNode } from "@/services/agents/conductor";

const SITE = "00000000-0000-4000-8000-0000000000aa";

function started(ctx: FastBuildContext): FastBuildOutcome {
  return {
    kind: "started",
    result: {
      conductor_run_id: ctx.conductor_run_id,
      provision: { provisioned: ["repo"], connected: [], pending_creds: [], failed: [], context: { site_id: SITE } },
      target: { github_full_name: "praxis-built/acme-1", default_branch: "main", github_target_mode: "umbrella" },
      first_build_free: ctx.first_build_free,
    },
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
    resolveSiteName: vi.fn().mockResolvedValue("Acme Fleet"),
    claimSiteSetupRetry: vi.fn().mockResolvedValue("resumed"),
    ...over,
  };
  return d as typeof d & StartProductBuildDeps;
}

const BASE = { tenant_id: "t1", company_name: "Acme Corp", idea: "A SaaS for managing fleet vehicles", started_by_user_id: "u1" };

function failedWrite(d: ReturnType<typeof deps>) {
  const call = vi.mocked(d.updateConductorRunStatus).mock.calls.find((c) => (c[0] as { status: string }).status === "failed");
  if (!call) throw new Error("no failed write");
  return call[0] as { conductor_run_id: string; goal_graph: ConductorNode[]; failure_class: string; failure_reason: string; objective?: string };
}

describe("startProductBuild — the one pipeline", () => {
  it("acquires the slot with the site estimate, then hands the run to the site saga with server-derived context", async () => {
    const d = deps();
    const r = await startProductBuild({ ...BASE, reference_images: ["https://a/1.png", "http://no", "https://a/2.png"] }, d);
    expect(r.conductor_run_id).toBe("cr_1");
    expect(d.tryAcquireBuildSlot).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "t1",
        max_usd: DEFAULT_PRODUCT_BUILD_MAX_USD,
        provision_estimate: DEFAULT_FAST_BUILD_ESTIMATE_USD,
        max_per_day: MAX_PRODUCT_BUILDS_PER_DAY,
      }),
    );
    expect(d.startFastBuild).toHaveBeenCalledWith({
      tenant_id: "t1",
      conductor_run_id: "cr_1",
      company_name: "Acme Corp",
      workspace_name: "Acme Workspace",
      site_name: "Acme Fleet",
      idea: BASE.idea,
      max_usd: DEFAULT_PRODUCT_BUILD_MAX_USD,
      started_by_user_id: "u1",
      owner_email: "owner@example.com",
      first_build_free: false,
      reference_images: ["https://a/1.png", "https://a/2.png"],
    });
    expect(d.updateConductorRunStatus).not.toHaveBeenCalled();
  });

  it("clamps max_usd to the server ceiling and never writes a null cap", async () => {
    const d = deps();
    await startProductBuild({ ...BASE, max_usd: 9999 }, d);
    expect(vi.mocked(d.tryAcquireBuildSlot).mock.calls[0][0].max_usd).toBe(MAX_PRODUCT_BUILD_MAX_USD);
    const d2 = deps();
    await startProductBuild({ ...BASE, max_usd: null }, d2);
    expect(vi.mocked(d2.tryAcquireBuildSlot).mock.calls[0][0].max_usd).toBe(DEFAULT_PRODUCT_BUILD_MAX_USD);
  });

  it("rejects an invalid company name before any side effect", async () => {
    const d = deps();
    await expect(startProductBuild({ ...BASE, company_name: "../etc" }, d)).rejects.toBeInstanceOf(InvalidCompanyName);
    expect(d.checkSitePrereqs).not.toHaveBeenCalled();
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });

  it.each([
    ["double build", new DoubleBuildInFlight("t1")],
    ["daily limit", new TooManyBuildsToday("t1", 10, 10)],
    ["over cap", new ProvisionBudgetExceeded(2)],
  ])("a slot refusal (%s) surfaces as is, with no site", async (_n, err) => {
    const d = deps({ tryAcquireBuildSlot: vi.fn().mockRejectedValue(err) });
    await expect(startProductBuild(BASE, d)).rejects.toBe(err);
    expect(d.startFastBuild).not.toHaveBeenCalled();
  });

  it("an owner-email lookup error means no pre-registered admin, not a failed build", async () => {
    const d = deps({ resolveOwnerEmail: vi.fn().mockRejectedValue(new Error("auth down")) });
    await startProductBuild(BASE, d);
    expect(vi.mocked(d.startFastBuild).mock.calls[0][0].owner_email).toBeNull();
  });
});

describe("startProductBuild — prerequisites (SITE_BACKEND_UNAVAILABLE)", () => {
  it("a missing prerequisite is refused BEFORE the slot: nothing created, nothing charged, key names only", async () => {
    const d = deps({ checkSitePrereqs: vi.fn(async () => ({ ok: false as const, missing: ["GITHUB_PROVISION_TOKEN", "pooled site backend: no_open_shard_prod"] })) });
    const err = await startProductBuild(BASE, d).catch((e) => e);
    expect(err).toBeInstanceOf(SiteBackendUnavailable);
    expect(err).toBeInstanceOf(BuildRepoNotProvisioned);
    expect(err.code).toBe(SITE_BACKEND_UNAVAILABLE_CODE);
    expect(err.retryable).toBe(true);
    expect(err.missing).toEqual(["GITHUB_PROVISION_TOKEN", "pooled site backend: no_open_shard_prod"]);
    expect(err.message).toBe(SITE_SETUP_UNAVAILABLE_COPY);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    expect(d.startFastBuild).not.toHaveBeenCalled();
  });

  it("a prerequisite check that throws is treated as unavailable, never as ready", async () => {
    const d = deps({ checkSitePrereqs: vi.fn().mockRejectedValue(new Error("boom")) });
    await expect(startProductBuild(BASE, d)).rejects.toBeInstanceOf(SiteBackendUnavailable);
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
  });

  it("our own outage is reported before the wallet: never 'top up' while builds are down", async () => {
    const d = deps({
      checkSitePrereqs: vi.fn(async () => ({ ok: false as const, missing: ["E2B_API_KEY (or E2B_KEY)"] })),
      assertBuildCredits: vi.fn().mockRejectedValue(new InsufficientCreditsForBuild(6_500, 1_000)),
    });
    await expect(startProductBuild(BASE, d)).rejects.toBeInstanceOf(SiteBackendUnavailable);
  });

  it("the prerequisite check, credit check and daily-cap read all start before any settles", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = deps({
      checkSitePrereqs: vi.fn(async () => { started.push("prereqs"); await gate; return { ok: true as const }; }),
      assertBuildCredits: vi.fn(async () => { started.push("credits"); await gate; }),
      resolveDailyCap: vi.fn(async () => { started.push("cap"); await gate; return 0; }),
    });
    const p = startProductBuild(BASE, d);
    await Promise.resolve();
    await Promise.resolve();
    expect(started.sort()).toEqual(["cap", "credits", "prereqs"]);
    release();
    await p;
  });
});

describe("startProductBuild — a site setup failure", () => {
  it("keeps the real cause on the run, sanitized, while the founder still sees only the copy", async () => {
    const detail = "GitHub 401: Bad credentials for https://x-access-token:ghp_secret@github.com/org/repo token=ghp_secret";
    const d = deps({ startFastBuild: vi.fn().mockResolvedValue({ kind: "setup_failed", reason: "provisioning_failed:repo", detail, retryable: true, site_id: SITE }) });
    const err = await startProductBuild(BASE, d).catch((e) => e);
    expect(err.message).toBe(SITE_SETUP_UNAVAILABLE_COPY);
    expect(buildSetupFailedBody(err).message).toBe(SITE_SETUP_UNAVAILABLE_COPY);
    expect(JSON.stringify(buildSetupFailedBody(err))).not.toContain("401");
    const w = failedWrite(d);
    const provision = w.goal_graph.find((n) => n.payload?.stage === "provision")!;
    for (const stored of [w.failure_reason, provision.error!, provision.last_failure_signal!]) {
      expect(stored).toContain("provisioning_failed:repo");
      expect(stored).toContain("GitHub 401: Bad credentials");
      expect(stored).not.toContain("ghp_secret");
      expect(stored.split("\n")[0]).toBe(SITE_SETUP_UNAVAILABLE_COPY);
    }
    const failure = summarizeBuildFailure({ runStatus: "failed", graph: w.goal_graph, children: new Map() });
    const view = founderFailureView(failure, []);
    expect(view?.message).toBe(SITE_SETUP_UNAVAILABLE_COPY);
    expect(JSON.stringify(view)).not.toContain("401");
    expect(founderStageError(provision.error!, "failed", "stage_failed", true)).toBe(SITE_SETUP_UNAVAILABLE_COPY);
  });

  it("fails the run (slot released) with the founder copy and a RETRYABLE marker pointing at the site", async () => {
    const d = deps({ startFastBuild: vi.fn().mockResolvedValue({ kind: "setup_failed", reason: "provisioning_failed:repo", retryable: true, site_id: SITE }) });
    const err = await startProductBuild(BASE, d).catch((e) => e);
    expect(err).toBeInstanceOf(SiteSetupUnavailable);
    expect(err.message).toBe(SITE_SETUP_UNAVAILABLE_COPY);
    const w = failedWrite(d);
    expect(w.conductor_run_id).toBe("cr_1");
    expect(w.failure_class).toBe("provision_failed");
    expect(w.objective).toContain("Acme Fleet");
    const provision = w.goal_graph.find((n) => n.payload?.stage === "provision")!;
    expect(provision.status).toBe("failed");
    expect(provision.payload.site_id).toBe(SITE);
    expect(siteSetupRetryable(w.goal_graph)).toBe(true);
    expect(siteSetupMarker(w.goal_graph)).toMatchObject({
      company_name: "Acme Corp",
      idea: BASE.idea,
      site_name: "Acme Fleet",
      workspace_name: "Acme Workspace",
      started_by_user_id: "u1",
      first_build_free: false,
    });
    expect(JSON.stringify(w.goal_graph)).not.toContain("owner@example.com");
  });

  it("the 503 body names the failed run to retry in place (only when retryable), with the typed reason for a prerequisite", async () => {
    const d = deps({ startFastBuild: vi.fn().mockResolvedValue({ kind: "setup_failed", reason: "x", retryable: true, site_id: SITE }) });
    const err = await startProductBuild(BASE, d).catch((e) => e);
    expect(buildSetupFailedBody(err)).toEqual({ code: "build_setup_failed", message: SITE_SETUP_UNAVAILABLE_COPY, retryable: true, run_id: "cr_1" });
    const dead = deps({ startFastBuild: vi.fn().mockResolvedValue({ kind: "setup_failed", reason: "x", retryable: false }) });
    const err2 = await startProductBuild(BASE, dead).catch((e) => e);
    expect(buildSetupFailedBody(err2)).toEqual({ code: "build_setup_failed", message: SITE_SETUP_UNAVAILABLE_COPY, retryable: false });
    const pre = deps({ checkSitePrereqs: vi.fn(async () => ({ ok: false as const, missing: ["X"] })) });
    const err3 = await startProductBuild(BASE, pre).catch((e) => e);
    expect(buildSetupFailedBody(err3)).toEqual({
      code: "build_setup_failed",
      message: SITE_SETUP_UNAVAILABLE_COPY,
      retryable: true,
      reason_code: SITE_BACKEND_UNAVAILABLE_CODE,
    });
  });

  it("a site that died is a NON-retryable failure", async () => {
    const d = deps({ startFastBuild: vi.fn().mockResolvedValue({ kind: "setup_failed", reason: "site_deleting", retryable: false, site_id: SITE }) });
    await expect(startProductBuild(BASE, d)).rejects.toBeInstanceOf(SiteSetupUnavailable);
    expect(siteSetupRetryable(failedWrite(d).goal_graph)).toBe(false);
  });

  it("a saga throw (stopped while provisioning) fails the run, not retryable", async () => {
    const d = deps({ startFastBuild: vi.fn().mockRejectedValue(new Error("The build was stopped while its site was being set up.")) });
    await expect(startProductBuild(BASE, d)).rejects.toThrow(/stopped/);
    expect(siteSetupRetryable(failedWrite(d).goal_graph)).toBe(false);
  });

  it("when the failed write itself fails, the run is cancelled through the tenant-bound RPC", async () => {
    const d = deps({
      startFastBuild: vi.fn().mockResolvedValue({ kind: "setup_failed", reason: "x", retryable: true }),
      updateConductorRunStatus: vi.fn().mockRejectedValue(new Error("db down")),
    });
    await expect(startProductBuild(BASE, d)).rejects.toBeInstanceOf(SiteSetupUnavailable);
    expect(d.cancelConductorRun).toHaveBeenCalledWith("t1", "cr_1");
  });
});

describe("retrySiteSetup — Retry resumes the same run's site", () => {
  async function failedRow() {
    const d = deps({ startFastBuild: vi.fn().mockResolvedValue({ kind: "setup_failed", reason: "provisioning_failed:repo", retryable: true, site_id: SITE }) });
    await startProductBuild({ ...BASE, reference_images: ["https://a/1.png"] }, d).catch(() => undefined);
    return { id: "cr_1", updated_at: "2026-10-02T00:00:00.000Z", goal_graph: failedWrite(d).goal_graph };
  }

  it("claims the run under the build lock, then re-runs the SAME saga for the same run", async () => {
    const row = await failedRow();
    const d = deps();
    const r = await retrySiteSetup("t1", row, d);
    expect(r).toEqual({ ok: true, run_id: "cr_1" });
    expect(d.claimSiteSetupRetry).toHaveBeenCalledWith({
      tenant_id: "t1",
      conductor_run_id: "cr_1",
      expected_updated_at: row.updated_at,
      site_id: SITE,
    });
    expect(d.startFastBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "t1",
        conductor_run_id: "cr_1",
        company_name: "Acme Corp",
        site_name: "Acme Fleet",
        owner_email: "owner@example.com",
        reference_images: ["https://a/1.png"],
      }),
    );
    expect(d.tryAcquireBuildSlot).not.toHaveBeenCalled();
    expect(d.assertBuildCredits).not.toHaveBeenCalled();
  });

  it.each([
    ["another_build_running", "another_build_running"],
    ["changed_concurrently", "changed_concurrently"],
    ["site_gone", "not_resumable"],
    ["not_resumable", "not_resumable"],
    ["not_found", "not_found"],
  ] as const)("a %s claim changes nothing and answers %s", async (claim, code) => {
    const row = await failedRow();
    const d = deps({ claimSiteSetupRetry: vi.fn().mockResolvedValue(claim) });
    const r = await retrySiteSetup("t1", row, d);
    expect(r).toMatchObject({ ok: false, code });
    expect(d.startFastBuild).not.toHaveBeenCalled();
  });

  it("a missing prerequisite refuses the retry before the claim", async () => {
    const row = await failedRow();
    const d = deps({ checkSitePrereqs: vi.fn(async () => ({ ok: false as const, missing: ["E2B_API_KEY (or E2B_KEY)"] })) });
    expect(await retrySiteSetup("t1", row, d)).toEqual({
      ok: false,
      code: "site_setup_failed",
      message: SITE_SETUP_UNAVAILABLE_COPY,
      retryable: true,
      reason_code: SITE_BACKEND_UNAVAILABLE_CODE,
    });
    expect(d.claimSiteSetupRetry).not.toHaveBeenCalled();
  });

  it("a retry that fails again fails the run again, still retryable", async () => {
    const row = await failedRow();
    const d = deps({ startFastBuild: vi.fn().mockResolvedValue({ kind: "setup_failed", reason: "provisioning_failed:repo", retryable: true, site_id: SITE }) });
    const r = await retrySiteSetup("t1", row, d);
    expect(r).toEqual({ ok: false, code: "site_setup_failed", message: SITE_SETUP_UNAVAILABLE_COPY, retryable: true });
    expect(siteSetupRetryable(failedWrite(d).goal_graph)).toBe(true);
  });

  it("a run without a retryable marker is never claimed", async () => {
    const d = deps();
    const r = await retrySiteSetup("t1", { id: "cr_9", updated_at: "x", goal_graph: [{ payload: { stage: "provision" } }] }, d);
    expect(r).toMatchObject({ ok: false, code: "not_resumable" });
    expect(d.claimSiteSetupRetry).not.toHaveBeenCalled();
  });
});
