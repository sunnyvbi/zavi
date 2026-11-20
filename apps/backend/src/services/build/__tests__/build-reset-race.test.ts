import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetVersionPreviewJobs,
  ERR_BUILD_IN_PROGRESS,
  getVersionPreview,
  startVersionPreview,
  type VersionPreviewDeps,
  type VersionPreviewJob,
} from "@/services/build/version-preview";
import { LiveEditError, invalidateLiveEditState, wakeLiveEditPreview, type LiveEditDeps, type WakeDeps } from "@/services/build/live-edit";

const SHA = "3f9a1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c";
const TARGET = { github_full_name: "praxis-built/acme", default_branch: "main" };
const INPUT = { tenant_id: "t-race", conductor_run_id: "cr_race_0001" };
const HEAD = "d".repeat(40);

type Fn = ReturnType<typeof vi.fn>;

function sandboxWorld() {
  const world = { building: false, uncommittedEdits: false, wiped: false };
  const resetHard = () => {
    if (world.uncommittedEdits) world.wiped = true;
  };
  const refineStarts = () => {
    world.building = true;
    world.uncommittedEdits = true;
  };
  const hasActiveBuild = vi.fn(async () => world.building);
  return { world, resetHard, refineStarts, hasActiveBuild };
}

function vpDeps(w: ReturnType<typeof sandboxWorld>, over: Partial<VersionPreviewDeps> = {}) {
  return {
    resolveVersionCommit: vi.fn().mockResolvedValue({ commit_sha: SHA, label: "x", target: TARGET, installation_id: -1 }),
    mintInstallationToken: vi.fn().mockResolvedValue("ghs_fresh"),
    injectSecrets: vi.fn().mockResolvedValue(undefined),
    wipeSecrets: vi.fn().mockResolvedValue(undefined),
    hasActiveBuild: w.hasActiveBuild,
    resolveSandbox: vi.fn(async () => {
      w.resetHard();
      return { row_id: "row1", e2b_sandbox_id: "sb1" };
    }),
    bootstrapRepo: vi.fn().mockResolvedValue(undefined),
    restoreLiveDraft: vi.fn(async () => {
      w.resetHard();
    }),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exit_code: 0 }),
    startPreview: vi.fn().mockResolvedValue({ url: "https://3400-sb1.e2b.app", port: 3400 }),
    probe: vi.fn().mockResolvedValue(true),
    now: vi.fn(() => 1_000_000),
    ...over,
  } as unknown as VersionPreviewDeps & Record<keyof VersionPreviewDeps, Fn>;
}

async function settled(d: VersionPreviewDeps): Promise<VersionPreviewJob> {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setImmediate(r));
    const job = await getVersionPreview(INPUT, d);
    if (job && job.status !== "starting") return job;
  }
  throw new Error("job never left starting");
}

function leDeps(w: ReturnType<typeof sandboxWorld>): LiveEditDeps {
  return {
    enabled: vi.fn().mockResolvedValue(true),
    loadTarget: vi.fn().mockResolvedValue(TARGET),
    assertProvisioned: vi.fn().mockResolvedValue(true),
    installation: vi.fn().mockResolvedValue(-1),
    compare: vi.fn().mockResolvedValue({ ahead_by: 1, behind_by: 0, commits: [{ sha: HEAD, message: "x" }] }),
    branchSha: vi.fn().mockResolvedValue(HEAD),
    changedFiles: vi.fn().mockResolvedValue([]),
    protectedGlobs: vi.fn().mockResolvedValue([]),
    fastForward: vi.fn().mockResolvedValue(undefined),
    deleteBranch: vi.fn().mockResolvedValue(true),
    hasActiveBuild: w.hasActiveBuild,
    loadPreviewRow: vi.fn().mockResolvedValue(null),
    clearPreview: vi.fn().mockResolvedValue(undefined),
    touchPreview: vi.fn().mockResolvedValue(undefined),
    now: vi.fn(() => 1),
  } as never;
}

function wakeDeps(w: ReturnType<typeof sandboxWorld>, over: Partial<WakeDeps> = {}) {
  return {
    installationToken: vi.fn().mockResolvedValue("ghs_tok"),
    resolveSandbox: vi.fn(async () => {
      w.resetHard();
      return { row_id: "row-w", e2b_sandbox_id: "sb-w" };
    }),
    injectToken: vi.fn().mockResolvedValue(undefined),
    bootstrap: vi.fn().mockResolvedValue(undefined),
    checkout: vi.fn(async () => {
      w.resetHard();
      return { ok: true, sha: HEAD };
    }),
    wipe: vi.fn().mockResolvedValue(undefined),
    ensurePreview: vi.fn().mockResolvedValue({ url: "https://3000-sb-w.e2b.app", reused: false, reason: "booted" }),
    pause: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as WakeDeps & Record<keyof WakeDeps, Fn>;
}

beforeEach(() => {
  __resetVersionPreviewJobs();
  invalidateLiveEditState(INPUT.tenant_id);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("opening an old version never resets the shared repo under a refine that started after the first check", () => {
  it("a refine that starts while the GitHub token is being minted keeps its edits: the sandbox is never resumed or reset", async () => {
    const w = sandboxWorld();
    const d = vpDeps(w, {
      mintInstallationToken: vi.fn(async () => {
        w.refineStarts();
        return "ghs_fresh";
      }),
    });
    startVersionPreview(INPUT, d);
    const job = await settled(d);

    expect(w.world.wiped).toBe(false);
    expect(d.resolveSandbox).not.toHaveBeenCalled();
    expect(d.restoreLiveDraft).not.toHaveBeenCalled();
    expect(d.startPreview).not.toHaveBeenCalled();
    expect(job).toMatchObject({ status: "dead", error: ERR_BUILD_IN_PROGRESS });
  });

  it("a refine that starts while the repo is being cloned keeps its edits: the draft is not force-checked-out and no preview boots", async () => {
    const w = sandboxWorld();
    const d = vpDeps(w, {
      bootstrapRepo: vi.fn(async () => {
        w.refineStarts();
      }),
    });
    startVersionPreview(INPUT, d);
    const job = await settled(d);

    expect(w.world.wiped).toBe(false);
    expect(d.resolveSandbox).toHaveBeenCalledTimes(1);
    expect(d.restoreLiveDraft).not.toHaveBeenCalled();
    expect(d.exec).not.toHaveBeenCalled();
    expect(d.startPreview).not.toHaveBeenCalled();
    expect(d.wipeSecrets).toHaveBeenCalledWith("sb1");
    expect(job).toMatchObject({ status: "dead", error: ERR_BUILD_IN_PROGRESS });
  });

  it("with no build running, the version still boots and the draft is restored", async () => {
    const w = sandboxWorld();
    const d = vpDeps(w);
    startVersionPreview(INPUT, d);
    const job = await settled(d);

    expect(job.status).toBe("live");
    expect(d.resolveSandbox).toHaveBeenCalledTimes(1);
    expect(d.restoreLiveDraft).toHaveBeenCalledTimes(1);
  });
});

describe("waking the live-edit preview never resets the shared repo under a refine that started after the first check", () => {
  it("a refine that starts while the wake mints its token keeps its edits: 409 and the sandbox is never resumed or reset", async () => {
    const w = sandboxWorld();
    const wk = wakeDeps(w, {
      installationToken: vi.fn(async () => {
        w.refineStarts();
        return "ghs_tok";
      }),
    });
    let err: unknown = null;
    await wakeLiveEditPreview(INPUT.tenant_id, leDeps(w), wk).catch((e) => {
      err = e;
    });

    expect(w.world.wiped).toBe(false);
    expect(wk.resolveSandbox).not.toHaveBeenCalled();
    expect(wk.checkout).not.toHaveBeenCalled();
    expect(wk.ensurePreview).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(LiveEditError);
    expect((err as LiveEditError).code).toBe("build_in_progress");
    expect((err as LiveEditError).status).toBe(409);
  });

  it("with no build running, the wake resumes the sandbox and serves the draft", async () => {
    const w = sandboxWorld();
    const wk = wakeDeps(w);
    const res = await wakeLiveEditPreview(INPUT.tenant_id, leDeps(w), wk);

    expect(res.url).toBe("https://3000-sb-w.e2b.app");
    expect(wk.resolveSandbox).toHaveBeenCalledTimes(1);
    expect(wk.checkout).toHaveBeenCalledTimes(1);
  });
});
