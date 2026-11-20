import { describe, it, expect, vi } from "vitest";
import {
  shaMatches,
  decideDeployTruth,
  reconcileDeployRow,
  pollDeployTruth,
  enqueueDeployTruthWatch,
  MAX_DEPLOY_ATTEMPTS,
  type DeployTruthPollDeps,
  type DeployWatchRow,
  type EnqueueDeployTruthDeps,
  type RenderDeploy,
} from "../deploy-truth";

const MERGED = "a".repeat(40);
const OTHER = "b".repeat(40);

describe("shaMatches (deploy-truth SHA equality)", () => {
  it("full == full (case-insensitive)", () => {
    expect(shaMatches(MERGED, MERGED.toUpperCase())).toBe(true);
  });
  it("short prefix of full matches either direction", () => {
    expect(shaMatches("aaaaaaa", MERGED)).toBe(true);
    expect(shaMatches(MERGED, "aaaaaaa")).toBe(true);
  });
  it("different SHAs never match", () => {
    expect(shaMatches(MERGED, OTHER)).toBe(false);
  });
  it("empty / null / <7 / non-hex never match (can't confirm → keep watching)", () => {
    for (const bad of [null, undefined, "", "abc", "zzzzzzz", "  "]) {
      expect(shaMatches(bad, MERGED)).toBe(false);
    }
  });
});

describe("decideDeployTruth (pure classifier)", () => {
  it("no deploy yet → wait", () => {
    expect(decideDeployTruth({ deploy: null, mergedSha: MERGED, healthOk: false }).kind).toBe("wait");
  });

  it("SHA match + live + healthy → deploy_healthy", () => {
    const d: RenderDeploy = { status: "live", commit_sha: MERGED };
    expect(decideDeployTruth({ deploy: d, mergedSha: MERGED, healthOk: true }).kind).toBe("healthy");
  });

  it("SHA match + live but NOT healthy → wait (not-serving-2xx-yet)", () => {
    const d: RenderDeploy = { status: "live", commit_sha: MERGED };
    const r = decideDeployTruth({ deploy: d, mergedSha: MERGED, healthOk: false });
    expect(r.kind).toBe("wait");
    expect(r.reason).toMatch(/not serving 2xx/i);
  });

  it("live but Render is STILL SERVING THE OLD commit → wait (root-2xx-alone insufficient, codex #3)", () => {
    const d: RenderDeploy = { status: "live", commit_sha: OTHER };
    const r = decideDeployTruth({ deploy: d, mergedSha: MERGED, healthOk: true });
    expect(r.kind).toBe("wait");
    expect(r.reason).toMatch(/different commit/i);
  });

  it("render build FAILED for the merged commit → deploy_failed", () => {
    const d: RenderDeploy = { status: "build_failed", commit_sha: MERGED };
    expect(decideDeployTruth({ deploy: d, mergedSha: MERGED, healthOk: false }).kind).toBe("failed");
  });

  it("an OLDER deploy failed (different commit) → wait for the merged one, not failed", () => {
    const d: RenderDeploy = { status: "build_failed", commit_sha: OTHER };
    expect(decideDeployTruth({ deploy: d, mergedSha: MERGED, healthOk: false }).kind).toBe("wait");
  });

  it("in-progress / unknown → wait", () => {
    for (const s of ["created", "build_in_progress", "pre_deploy_in_progress", "weird"]) {
      const d: RenderDeploy = { status: s, commit_sha: MERGED };
      expect(decideDeployTruth({ deploy: d, mergedSha: MERGED, healthOk: false }).kind).toBe("wait");
    }
  });
});

function pollDeps(over: Partial<DeployTruthPollDeps> = {}): DeployTruthPollDeps & Record<string, ReturnType<typeof vi.fn>> {
  return {
    loadWatching: vi.fn().mockResolvedValue([]),
    fetchLatestDeploy: vi.fn().mockResolvedValue(null),
    fetchServiceUrl: vi.fn().mockResolvedValue("https://app.onrender.com"),
    probeHealth: vi.fn().mockResolvedValue(true),
    setState: vi.fn().mockResolvedValue(true),
    bumpAttempt: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as DeployTruthPollDeps & Record<string, ReturnType<typeof vi.fn>>;
}

const row = (over: Partial<DeployWatchRow> = {}): DeployWatchRow => ({
  id: 1,
  tenant_id: "t-1",
  pr_url: "https://github.com/o/r/pull/1",
  merged_sha: MERGED,
  render_service_id: "srv-1",
  attempt_count: 0,
  ...over,
});

describe("reconcileDeployRow", () => {
  it("SHA match + health ok → set deploy_healthy with served_sha + health_url", async () => {
    const deps = pollDeps({
      fetchLatestDeploy: vi.fn().mockResolvedValue({ status: "live", commit_sha: MERGED }),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://app.onrender.com"),
      probeHealth: vi.fn().mockResolvedValue(true),
    });
    const out = await reconcileDeployRow(deps, row(), "srv-1");
    expect(out).toBe("healthy");
    expect(deps.setState).toHaveBeenCalledWith(1, "deploy_healthy", MERGED, "https://app.onrender.com", expect.any(String));
    expect(deps.bumpAttempt).not.toHaveBeenCalled();
  });

  it("SHA MISMATCH (Render still serving old) → bump attempt, stays watching, NEVER probes health", async () => {
    const probeHealth = vi.fn().mockResolvedValue(true);
    const deps = pollDeps({
      fetchLatestDeploy: vi.fn().mockResolvedValue({ status: "live", commit_sha: OTHER }),
      probeHealth,
    });
    const out = await reconcileDeployRow(deps, row({ attempt_count: 2 }), "srv-1");
    expect(out).toBe("watching");
    expect(deps.bumpAttempt).toHaveBeenCalledWith(1, OTHER, expect.stringMatching(/different commit/i));
    expect(probeHealth).not.toHaveBeenCalled();
    expect(deps.setState).not.toHaveBeenCalled();
  });

  it("SHA match but health FAILS → bump (watching), does not go healthy", async () => {
    const deps = pollDeps({
      fetchLatestDeploy: vi.fn().mockResolvedValue({ status: "live", commit_sha: MERGED }),
      probeHealth: vi.fn().mockResolvedValue(false),
    });
    const out = await reconcileDeployRow(deps, row({ attempt_count: 0 }), "srv-1");
    expect(out).toBe("watching");
    expect(deps.bumpAttempt).toHaveBeenCalled();
    expect(deps.setState).not.toHaveBeenCalled();
  });

  it("render build failed for the merged commit → deploy_failed immediately", async () => {
    const deps = pollDeps({
      fetchLatestDeploy: vi.fn().mockResolvedValue({ status: "build_failed", commit_sha: MERGED }),
    });
    const out = await reconcileDeployRow(deps, row(), "srv-1");
    expect(out).toBe("failed");
    expect(deps.setState).toHaveBeenCalledWith(1, "deploy_failed", MERGED, null, expect.stringMatching(/build failed/i));
  });

  it("at the attempt CAP without a healthy match → flip deploy_failed (no infinite watch, Q8)", async () => {
    const deps = pollDeps({
      fetchLatestDeploy: vi.fn().mockResolvedValue({ status: "live", commit_sha: OTHER }),
    });
    const out = await reconcileDeployRow(deps, row({ attempt_count: MAX_DEPLOY_ATTEMPTS - 1 }), "srv-1");
    expect(out).toBe("failed");
    expect(deps.setState).toHaveBeenCalledWith(1, "deploy_failed", OTHER, null, expect.stringMatching(/window elapsed/i));
    expect(deps.bumpAttempt).not.toHaveBeenCalled();
  });
});

describe("pollDeployTruth (sweep)", () => {
  it("tallies healthy/failed/watching and skips rows without a render_service_id", async () => {
    const deps = pollDeps({
      loadWatching: vi.fn().mockResolvedValue([
        row({ id: 1, render_service_id: "srv-1", merged_sha: MERGED }),
        row({ id: 2, render_service_id: null }),
      ]),
      fetchLatestDeploy: vi.fn().mockResolvedValue({ status: "live", commit_sha: MERGED }),
      probeHealth: vi.fn().mockResolvedValue(true),
    });
    const res = await pollDeployTruth(deps);
    expect(res.checked).toBe(1);
    expect(res.healthy).toBe(1);
  });

  it("one throwing row is isolated (errored++), does not stall the sweep", async () => {
    const deps = pollDeps({
      loadWatching: vi.fn().mockResolvedValue([row({ id: 1 }), row({ id: 2 })]),
      fetchLatestDeploy: vi
        .fn()
        .mockRejectedValueOnce(new Error("render 500"))
        .mockResolvedValueOnce({ status: "live", commit_sha: MERGED }),
      probeHealth: vi.fn().mockResolvedValue(true),
    });
    const res = await pollDeployTruth(deps);
    expect(res.checked).toBe(2);
    expect(res.errored).toBe(1);
    expect(res.healthy).toBe(1);
  });
});

function enqDeps(over: Partial<EnqueueDeployTruthDeps> = {}): EnqueueDeployTruthDeps & Record<string, ReturnType<typeof vi.fn>> {
  return {
    resolveProvisionedRepoTenant: vi.fn().mockResolvedValue("t-1"),
    resolveHostingServiceId: vi.fn().mockResolvedValue("srv-1"),
    deployTruthEnabled: vi.fn().mockResolvedValue(true),
    upsertWatch: vi.fn().mockResolvedValue(42),
    ...over,
  } as EnqueueDeployTruthDeps & Record<string, ReturnType<typeof vi.fn>>;
}

describe("enqueueDeployTruthWatch (webhook side)", () => {
  const base = {
    repoFullName: "praxis-build/acme-app",
    prUrl: "https://github.com/praxis-build/acme-app/pull/7",
    mergeCommitSha: MERGED,
    mergedAt: "2026-07-05T00:00:00Z",
  };

  it("provisioned app + merge_commit_sha + kill-switch ON → records a deploy_watching row with the MERGED SHA and repo-resolved tenant", async () => {
    const deps = enqDeps();
    const out = await enqueueDeployTruthWatch({ ...base, deps });
    expect(out.enqueued).toBe(true);
    expect(out.reason).toBe("watching");
    expect(out.deploy_id).toBe(42);
    expect(deps.resolveProvisionedRepoTenant).toHaveBeenCalledWith("praxis-build/acme-app");
    expect(deps.upsertWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "t-1",
        pr_url: base.prUrl,
        github_full_name: "praxis-build/acme-app",
        merged_sha: MERGED,
        render_service_id: "srv-1",
      }),
    );
  });

  it("no merge_commit_sha → no watch (fail-closed, can't compare)", async () => {
    const deps = enqDeps();
    const out = await enqueueDeployTruthWatch({ ...base, mergeCommitSha: null, deps });
    expect(out.enqueued).toBe(false);
    expect(out.reason).toBe("no_merge_commit_sha");
    expect(deps.upsertWatch).not.toHaveBeenCalled();
  });

  it("NOT a provisioned app (no tenant_resources repo row) → no watch (no row = no touch)", async () => {
    const deps = enqDeps({ resolveProvisionedRepoTenant: vi.fn().mockResolvedValue(null) });
    const out = await enqueueDeployTruthWatch({ ...base, deps });
    expect(out.enqueued).toBe(false);
    expect(out.reason).toBe("not_a_provisioned_app");
    expect(deps.deployTruthEnabled).not.toHaveBeenCalled();
    expect(deps.upsertWatch).not.toHaveBeenCalled();
  });

  it("kill-switch OFF → no watch (pre-C2 behavior)", async () => {
    const deps = enqDeps({ deployTruthEnabled: vi.fn().mockResolvedValue(false) });
    const out = await enqueueDeployTruthWatch({ ...base, deps });
    expect(out.enqueued).toBe(false);
    expect(out.reason).toBe("kill_switch_off");
    expect(deps.upsertWatch).not.toHaveBeenCalled();
  });

  it("provisioned repo but no hosting service → no watch (nothing to compare against)", async () => {
    const deps = enqDeps({ resolveHostingServiceId: vi.fn().mockResolvedValue(null) });
    const out = await enqueueDeployTruthWatch({ ...base, deps });
    expect(out.enqueued).toBe(false);
    expect(out.reason).toBe("no_hosting_service");
    expect(deps.upsertWatch).not.toHaveBeenCalled();
  });
});
