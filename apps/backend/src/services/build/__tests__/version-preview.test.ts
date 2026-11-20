import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetVersionPreviewJobs,
  ERR_BOOT_FAILED,
  ERR_BOOT_TIMEOUT,
  ERR_COMMIT_NOT_FOUND,
  ERR_STOPPED,
  getVersionPreview,
  startVersionPreview,
  VERSION_PREVIEW_PROBE_INTERVAL_MS,
  VERSION_PREVIEW_TTL_MS,
  type VersionPreviewDeps,
  type VersionPreviewJob,
} from "@/services/build/version-preview";
import { NotProvisioned, NothingToRestore } from "@/services/agents/refine-undo";
import { PreviewBootError } from "@/services/sandbox/preview";

const SHA = "3f9a1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c";
const DIR = `/home/user/version-${SHA.slice(0, 12)}`;
const PORT = 3400;
const TARGET = { github_full_name: "praxis-built/acme", default_branch: "main" };
const INPUT = { tenant_id: "t1", conductor_run_id: "cr_abcdefgh_1234" };

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Mocked = VersionPreviewDeps & { [K in keyof VersionPreviewDeps]: ReturnType<typeof vi.fn> };

function deps(over: Partial<VersionPreviewDeps> = {}, clock = { t: 1_000_000 }): Mocked {
  return {
    resolveVersionCommit: vi.fn().mockResolvedValue({ commit_sha: SHA, label: "Darker hero", target: TARGET, installation_id: -1 }),
    mintInstallationToken: vi.fn().mockResolvedValue("ghs_fresh"),
    resolveSandbox: vi.fn().mockResolvedValue({ row_id: "row1", e2b_sandbox_id: "sb1" }),
    bootstrapRepo: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exit_code: 0 }),
    startPreview: vi.fn().mockResolvedValue({ url: `https://${PORT}-sb1.e2b.app`, port: PORT }),
    probe: vi.fn().mockResolvedValue(true),
    now: vi.fn(() => clock.t),
    ...over,
  } as unknown as Mocked;
}

async function settled(d: VersionPreviewDeps, input = INPUT): Promise<VersionPreviewJob> {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setImmediate(r));
    const job = await getVersionPreview(input, d);
    if (job && job.status !== "starting") return job;
  }
  throw new Error("job never left starting");
}

beforeEach(() => {
  __resetVersionPreviewJobs();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("startVersionPreview — boots an earlier commit in the tenant sandbox", () => {
  it("returns 'starting' synchronously, then goes live with the version's sha, worktree dir and derived port", async () => {
    const d = deps();
    const first = startVersionPreview(INPUT, d);
    expect(first).toMatchObject({ status: "starting", url: null, port: null, commit_sha: null, error: null });

    const job = await settled(d);
    expect(job).toMatchObject({ status: "live", url: `https://${PORT}-sb1.e2b.app`, port: PORT, commit_sha: SHA, error: null });

    expect(d.resolveVersionCommit).toHaveBeenCalledWith(INPUT);
    expect(d.resolveSandbox).toHaveBeenCalledWith({
      tenant_id: "t1",
      repo_full_name: "praxis-built/acme",
      provisioned: true,
      run_id: "vp-cr_abcde",
      installation_token: "ghs_fresh",
    });
    expect(d.bootstrapRepo).toHaveBeenCalledWith("sb1", "praxis-built/acme", "t1");
    const [sandboxId, script] = d.exec.mock.calls[0];
    expect(sandboxId).toBe("sb1");
    expect(script).toContain(`git fetch origin ${SHA}`);
    expect(script).toContain(`git worktree add --detach '${DIR}' ${SHA}`);
    expect(script).toContain(`[ -d '${DIR}' ]`);
    expect(d.startPreview).toHaveBeenCalledWith({
      sandbox_id: "sb1",
      worktree_dir: DIR,
      run_id: `vp-${SHA.slice(0, 12)}`,
      port: PORT,
      boot_timeout_seconds: 90,
      start_cmd: `ZAVI_VERSION_PREVIEW=1 npm run dev -- -p ${PORT}`,
    });
    expect(PORT).toBe(3400);
    const stop = d.exec.mock.calls.find(([, script]) => String(script).includes("mypg"));
    expect(stop).toBeTruthy();
    expect(String(stop![1])).toContain("preview-v[p]-");
    expect(String(stop![1])).toContain("ZAVI_VERSION_PREVIE[W]=1");
    expect(String(stop![1])).not.toContain("ZAVI_VERSION_PREVIEW=1");
    expect(String(stop![1])).toContain("340[0]");
    expect(String(stop![1])).toContain("mypg");
    expect(PORT).toBeLessThan(3450);
  });

  it("orders the sandbox before the fetch and the fetch before the boot", async () => {
    const order: string[] = [];
    const d = deps({
      resolveSandbox: vi.fn(async () => {
        order.push("sandbox");
        return { row_id: "row1", e2b_sandbox_id: "sb1" };
      }),
      bootstrapRepo: vi.fn(async () => {
        order.push("bootstrap");
      }),
      exec: vi.fn(async (_id: string, script: string) => {
        order.push(String(script).includes("mypg") ? "stop-previous" : "fetch");
        return { stdout: "", stderr: "", exit_code: 0 };
      }),
      startPreview: vi.fn(async () => {
        order.push("boot");
        return { url: "https://x", port: PORT };
      }),
    });
    startVersionPreview(INPUT, d);
    await settled(d);
    expect(order).toEqual(["sandbox", "bootstrap", "fetch", "stop-previous", "boot"]);
  });

  it("a second start while the first is still starting returns the same job and boots exactly once", async () => {
    const gate = deferred<{ url: string; port: number }>();
    const d = deps({ startPreview: vi.fn(() => gate.promise) });
    const a = startVersionPreview(INPUT, d);
    await new Promise((r) => setImmediate(r));
    const b = startVersionPreview(INPUT, d);
    expect(b.status).toBe("starting");
    expect(b.started_at).toBe(a.started_at);
    expect(b.commit_sha).toBe(SHA);
    expect(d.resolveVersionCommit).toHaveBeenCalledTimes(1);
    expect(d.resolveSandbox).toHaveBeenCalledTimes(1);

    gate.resolve({ url: "https://live", port: PORT });
    const job = await settled(d);
    expect(job.status).toBe("live");
    expect(d.startPreview).toHaveBeenCalledTimes(1);
    expect(d.resolveVersionCommit).toHaveBeenCalledTimes(1);
  });

  it("a live job is returned as-is on a repeat start (no second boot)", async () => {
    const d = deps();
    startVersionPreview(INPUT, d);
    const live = await settled(d);
    const again = startVersionPreview(INPUT, d);
    expect(again).toEqual(live);
    expect(d.startPreview).toHaveBeenCalledTimes(1);
  });

  it("jobs are keyed per tenant: another tenant asking for the same run id gets its own boot", async () => {
    const d = deps();
    startVersionPreview(INPUT, d);
    startVersionPreview({ tenant_id: "t2", conductor_run_id: INPUT.conductor_run_id }, d);
    await settled(d);
    await settled(d, { tenant_id: "t2", conductor_run_id: INPUT.conductor_run_id });
    expect(d.resolveVersionCommit).toHaveBeenCalledTimes(2);
    expect(d.resolveVersionCommit.mock.calls[1][0]).toMatchObject({ tenant_id: "t2" });
  });

  it("dies with the resolver's message when the commit cannot be resolved, and never touches a sandbox", async () => {
    const d = deps({ resolveVersionCommit: vi.fn().mockRejectedValue(new NothingToRestore("that version's commit could not be found")) });
    startVersionPreview(INPUT, d);
    const job = await settled(d);
    expect(job).toMatchObject({ status: "dead", url: null, port: null, error: "nothing to restore: that version's commit could not be found" });
    expect(d.mintInstallationToken).not.toHaveBeenCalled();
    expect(d.resolveSandbox).not.toHaveBeenCalled();
    expect(d.exec).not.toHaveBeenCalled();
    expect(d.startPreview).not.toHaveBeenCalled();
  });

  it("a non-provisioned repo is refused upstream and surfaces as dead with the gate's message, sandbox untouched", async () => {
    const d = deps({ resolveVersionCommit: vi.fn().mockRejectedValue(new NotProvisioned("mode=connected")) });
    startVersionPreview(INPUT, d);
    const job = await settled(d);
    expect(job).toMatchObject({ status: "dead", error: "refine-undo refused: mode=connected" });
    expect(d.resolveSandbox).not.toHaveBeenCalled();
  });

  it("refuses a sha that is not plain hex BEFORE any exec (a shell payload never reaches the sandbox)", async () => {
    const d = deps({
      resolveVersionCommit: vi.fn().mockResolvedValue({ commit_sha: "abc1234; rm -rf /home/user", label: "x", target: TARGET, installation_id: -1 }),
    });
    startVersionPreview(INPUT, d);
    const job = await settled(d);
    expect(job).toMatchObject({ status: "dead", error: ERR_COMMIT_NOT_FOUND, commit_sha: null });
    expect(d.resolveSandbox).not.toHaveBeenCalled();
    expect(d.exec).not.toHaveBeenCalled();
    expect(d.startPreview).not.toHaveBeenCalled();
  });

  it("refuses a sha shorter than 7 hex chars too", async () => {
    const d = deps({ resolveVersionCommit: vi.fn().mockResolvedValue({ commit_sha: "abc12", label: "x", target: TARGET, installation_id: -1 }) });
    startVersionPreview(INPUT, d);
    const job = await settled(d);
    expect(job).toMatchObject({ status: "dead", error: ERR_COMMIT_NOT_FOUND });
    expect(d.exec).not.toHaveBeenCalled();
  });

  it("a failed git fetch (commit not on origin) is dead as 'commit could not be found' and never boots", async () => {
    const d = deps({ exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "fatal: remote error: upload-pack: not our ref", exit_code: 128 }) });
    startVersionPreview(INPUT, d);
    const job = await settled(d);
    expect(job).toMatchObject({ status: "dead", error: ERR_COMMIT_NOT_FOUND, commit_sha: SHA });
    expect(d.startPreview).not.toHaveBeenCalled();
  });

  it("dies with 'didn't start in time' when the dev server never serves within the boot budget", async () => {
    const d = deps({
      startPreview: vi.fn().mockRejectedValue(new PreviewBootError("preview dev-server did not serve a 2xx within 90s (exit=1)", "not_ready:log_tail")),
    });
    startVersionPreview(INPUT, d);
    const job = await settled(d);
    expect(job).toMatchObject({ status: "dead", url: null, port: null, error: ERR_BOOT_TIMEOUT, commit_sha: SHA });
  });

  it("a non-timeout boot failure is dead with a generic message, never the raw sandbox error", async () => {
    const d = deps({
      startPreview: vi.fn().mockRejectedValue(new PreviewBootError("engineer preview copy prep failed (no node_modules, code=ERESOLVE)", "no_node_modules:ERESOLVE")),
    });
    startVersionPreview(INPUT, d);
    const job = await settled(d);
    expect(job).toMatchObject({ status: "dead", error: ERR_BOOT_FAILED });
    expect(job.error).not.toContain("ERESOLVE");
  });

  it("an unexpected sandbox error is dead with a generic message, never the raw text", async () => {
    const d = deps({ resolveSandbox: vi.fn().mockRejectedValue(new Error("resolveSandboxForRun: rpc failed: permission denied for table tenant_sandbox")) });
    startVersionPreview(INPUT, d);
    const job = await settled(d);
    expect(job).toMatchObject({ status: "dead", error: ERR_BOOT_FAILED });
    expect(job.error).not.toContain("permission denied");
  });

  it("a failed token mint does not block the boot; the sandbox is resolved without a token", async () => {
    const d = deps({ mintInstallationToken: vi.fn().mockRejectedValue(new Error("GITHUB_PROVISION_TOKEN not configured")) });
    startVersionPreview(INPUT, d);
    const job = await settled(d);
    expect(job.status).toBe("live");
    expect(d.resolveSandbox.mock.calls[0][0]).not.toHaveProperty("installation_token");
  });

  it("a dead job is replaced by a fresh boot on the next start", async () => {
    const d = deps({ exec: vi.fn().mockResolvedValueOnce({ stdout: "", stderr: "", exit_code: 128 }).mockResolvedValue({ stdout: "", stderr: "", exit_code: 0 }) });
    startVersionPreview(INPUT, d);
    expect((await settled(d)).status).toBe("dead");
    startVersionPreview(INPUT, d);
    expect((await settled(d)).status).toBe("live");
    expect(d.startPreview).toHaveBeenCalledTimes(1);
    expect(d.resolveVersionCommit).toHaveBeenCalledTimes(2);
  });

  it("a stale job past the 45-minute TTL is replaced, and its late result cannot overwrite the new job", async () => {
    const clock = { t: 1_000_000 };
    const gate = deferred<{ url: string; port: number }>();
    const d = deps({ startPreview: vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue({ url: "https://new", port: PORT }) }, clock);
    const stale = startVersionPreview(INPUT, d);
    await new Promise((r) => setImmediate(r));
    expect(stale.status).toBe("starting");

    clock.t += VERSION_PREVIEW_TTL_MS + 1;
    const fresh = startVersionPreview(INPUT, d);
    expect(fresh.started_at).toBe(clock.t);
    expect(fresh.status).toBe("starting");
    expect(d.resolveVersionCommit).toHaveBeenCalledTimes(2);

    gate.resolve({ url: "https://stale", port: PORT });
    const job = await settled(d);
    expect(job.url).toBe("https://new");
    expect(job.started_at).toBe(clock.t);
  });
});

describe("getVersionPreview — liveness", () => {
  it("returns null for an unknown job", async () => {
    expect(await getVersionPreview(INPUT, deps())).toBeNull();
  });

  it("does not probe a live job that was checked less than 2 minutes ago", async () => {
    const clock = { t: 1_000_000 };
    const d = deps({}, clock);
    startVersionPreview(INPUT, d);
    await settled(d);
    clock.t += VERSION_PREVIEW_PROBE_INTERVAL_MS - 1;
    const job = await getVersionPreview(INPUT, d);
    expect(job?.status).toBe("live");
    expect(d.probe).not.toHaveBeenCalled();
  });

  it("a live job whose preview stopped flips to dead on the next probe, and stays dead", async () => {
    const clock = { t: 1_000_000 };
    const d = deps({ probe: vi.fn().mockResolvedValue(false) }, clock);
    startVersionPreview(INPUT, d);
    const live = await settled(d);
    expect(live.status).toBe("live");

    clock.t += VERSION_PREVIEW_PROBE_INTERVAL_MS;
    const dead = await getVersionPreview(INPUT, d);
    expect(d.probe).toHaveBeenCalledWith(live.url);
    expect(dead).toMatchObject({ status: "dead", error: ERR_STOPPED, url: live.url, commit_sha: SHA });

    clock.t += VERSION_PREVIEW_PROBE_INTERVAL_MS;
    expect((await getVersionPreview(INPUT, d))?.status).toBe("dead");
    expect(d.probe).toHaveBeenCalledTimes(1);
  });

  it("a probe that throws counts as stopped", async () => {
    const clock = { t: 1_000_000 };
    const d = deps({ probe: vi.fn().mockRejectedValue(new Error("fetch failed")) }, clock);
    startVersionPreview(INPUT, d);
    await settled(d);
    clock.t += VERSION_PREVIEW_PROBE_INTERVAL_MS;
    expect((await getVersionPreview(INPUT, d))?.status).toBe("dead");
  });

  it("a healthy probe keeps the job live and re-arms the 2-minute window", async () => {
    const clock = { t: 1_000_000 };
    const d = deps({}, clock);
    startVersionPreview(INPUT, d);
    await settled(d);
    clock.t += VERSION_PREVIEW_PROBE_INTERVAL_MS;
    expect((await getVersionPreview(INPUT, d))?.status).toBe("live");
    expect(d.probe).toHaveBeenCalledTimes(1);
    clock.t += VERSION_PREVIEW_PROBE_INTERVAL_MS - 1;
    await getVersionPreview(INPUT, d);
    expect(d.probe).toHaveBeenCalledTimes(1);
    clock.t += 1;
    await getVersionPreview(INPUT, d);
    expect(d.probe).toHaveBeenCalledTimes(2);
  });

  it("after a probe kills a job, the next start boots a fresh preview", async () => {
    const clock = { t: 1_000_000 };
    const d = deps({ probe: vi.fn().mockResolvedValue(false) }, clock);
    startVersionPreview(INPUT, d);
    await settled(d);
    clock.t += VERSION_PREVIEW_PROBE_INTERVAL_MS;
    expect((await getVersionPreview(INPUT, d))?.status).toBe("dead");
    startVersionPreview(INPUT, d);
    expect((await settled(d)).status).toBe("live");
    expect(d.startPreview).toHaveBeenCalledTimes(2);
  });
});

describe("evictStaleVersionPreviews", () => {
  it("drops dead and expired jobs so the map cannot grow forever, but keeps a job still starting", async () => {
    const { evictStaleVersionPreviews, VERSION_PREVIEW_TTL_MS, __resetVersionPreviewJobs } = await import("../version-preview");
    __resetVersionPreviewJobs();
    let t = 1_000_000;
    const hanging = deps({ now: () => t, resolveVersionCommit: vi.fn(() => new Promise<never>(() => {})) });
    startVersionPreview({ tenant_id: "t1", conductor_run_id: "hangs" }, hanging);
    const dying = deps({ now: () => t, resolveVersionCommit: vi.fn().mockRejectedValue(new Error("x")) });
    startVersionPreview({ tenant_id: "t1", conductor_run_id: "died" }, dying);
    await settled(dying, { tenant_id: "t1", conductor_run_id: "died" });
    expect(evictStaleVersionPreviews(t)).toBe(0);
    t += VERSION_PREVIEW_TTL_MS + 1;
    expect(evictStaleVersionPreviews(t)).toBe(1);
    expect(await getVersionPreview({ tenant_id: "t1", conductor_run_id: "died" }, dying)).toBeNull();
    expect(await getVersionPreview({ tenant_id: "t1", conductor_run_id: "hangs" }, hanging)).not.toBeNull();
  });
});

describe("review fixes: no boot while a change is running; only the newest requested version owns the port", () => {
  it("refuses to touch the sandbox while a build or change is in progress", async () => {
    const { ERR_BUILD_IN_PROGRESS } = await import("../version-preview");
    const d = deps({ hasActiveBuild: vi.fn().mockResolvedValue(true) });
    startVersionPreview(INPUT, d);
    const job = await settled(d);
    expect(job).toMatchObject({ status: "dead", error: ERR_BUILD_IN_PROGRESS });
    expect(d.resolveSandbox).not.toHaveBeenCalled();
    expect(d.exec).not.toHaveBeenCalled();
  });

  it("a slower earlier pick never stops or claims the port after a newer pick started", async () => {
    const { ERR_REPLACED, __resetVersionPreviewJobs } = await import("../version-preview");
    __resetVersionPreviewJobs();
    const gate = deferred<void>();
    const first = deps({
      bootstrapRepo: vi.fn(async () => {
        await gate.promise;
      }),
    });
    startVersionPreview({ tenant_id: "t1", conductor_run_id: "older" }, first);
    const second = deps();
    startVersionPreview({ tenant_id: "t1", conductor_run_id: "newer" }, second);
    const newer = await settled(second, { tenant_id: "t1", conductor_run_id: "newer" });
    expect(newer.status).toBe("live");
    gate.resolve();
    const older = await settled(first, { tenant_id: "t1", conductor_run_id: "older" });
    expect(older).toMatchObject({ status: "dead", error: ERR_REPLACED });
    expect(first.exec.mock.calls.some(([, script]) => String(script).includes("mypg"))).toBe(false);
    expect(first.startPreview).not.toHaveBeenCalled();
  });
});
