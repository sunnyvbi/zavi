import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/sandbox/e2b-client", () => ({
  execCommand: vi.fn(),
  refreshOriginUrlStep: () =>
    `git remote set-url origin "https://x-access-token:$GITHUB_TOKEN@$(git remote get-url origin | sed -E 's#https://[^@]*@##')" && `,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
import {
  createRunWorktree, removeRunWorktree, reapOrphanWorktrees, worktreePathFor,
  redactGitCreds, WT_REAP_GRACE_MS,
} from "../run-worktree";
import { execCommand } from "@/services/sandbox/e2b-client";
import { logEvent } from "@/services/logging/logEvent";

const exec = vi.mocked(execCommand);
beforeEach(() => { exec.mockReset(); vi.mocked(logEvent).mockClear(); });
const res = (stdout: string, exit_code = 0) => ({ stdout, stderr: "", exit_code, ms: 0 });
const diskOk = () => res("FREE=99999999 REPO=1000 GIT=400");
const wtCmd = () =>
  String(exec.mock.calls.find((c) => String(c[1]).includes("worktree add"))?.[1] ?? "");
const lastWtCmd = () =>
  String(
    exec.mock.calls.filter((c) => String(c[1]).includes("worktree add")).at(-1)?.[1] ?? "",
  );

describe("run-worktree lifecycle", () => {
  it("createRunWorktree happy path → ok + path/branch", async () => {
    exec.mockResolvedValue(res("Preparing worktree\nRC=0"));
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "abc-123", base: "main" });
    expect(r).toMatchObject({ ok: true, path: "/home/user/wt-abc-123", branch: "_mt_wt_abc-123" });
    const cmd = wtCmd();
    expect(cmd).toMatch(/git .*worktree add -f -B .*_mt_wt_abc-123.* .*wt-abc-123.* origin\/.*main/);
    expect(cmd).toMatch(/checkout\.workers=1/);
    expect(cmd).toMatch(/checkout\.thresholdForParallelism=100/);
    expect(cmd).toMatch(/\[wt-diag\]/);
    expect(cmd).toMatch(/df -h/);
    expect(cmd).toMatch(/echo RC=\$RC\b/);
    expect(cmd).not.toMatch(/git fetch /);
    expect(cmd).toMatch(/flock -w 60 \/tmp\/_praxis_wt\.lock/);
  });

  it("fetchBase:true → refreshes origin URL + fetches the base into origin/<base> before add", async () => {
    exec.mockResolvedValue(res("done\nRC=0"));
    const r = await createRunWorktree({
      sandbox_id: "s", run_id: "f1", base: "engineer/upcar-private-booking-auto-capture",
      fetchBase: true,
    });
    expect(r.ok).toBe(true);
    const cmd = wtCmd();
    expect(cmd).toMatch(/git remote set-url origin .*x-access-token:\$GITHUB_TOKEN@/);
    expect(cmd).toMatch(/git fetch --no-tags origin .*engineer\/upcar-private-booking-auto-capture.*refs\/remotes\/origin\//);
    expect(cmd).toMatch(/flock -w 60 \/tmp\/_praxis_wt\.lock/);
    expect(cmd).toMatch(/git .*worktree add -f -B .* origin\/.*engineer\/upcar-private-booking-auto-capture/);
  });

  it("C14: a fetch failure that echoes the credentialed URL is REDACTED before becoming the error", async () => {
    exec.mockResolvedValue(res(
      "fatal: unable to access 'https://x-access-token:ghs_SUPERSECRETTOKEN@github.com/o/r.git/': 403\nRC=128",
    ));
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "f2", base: "engineer/x", fetchBase: true });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected worktree failure");
    expect(r.error).not.toContain("ghs_SUPERSECRETTOKEN");
    expect(r.error).not.toContain("x-access-token:ghs");
    expect(r.error).toContain("[redacted]");
  });

  it("fetchBase missing-ref WITHOUT defaultBase → ok:false (pre-fix prod behavior, the dispatch_error)", async () => {
    exec.mockResolvedValue(
      res("fatal: couldn't find remote ref engineer/del-399-x\nRC=128"),
    );
    const r = await createRunWorktree({
      sandbox_id: "s", run_id: "m1", base: "engineer/del-399-x", fetchBase: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected fail-closed");
    expect(r.error).toContain("couldn't find remote ref");
  });

  it("fetchBase missing-ref WITH defaultBase → falls back to origin/<defaultBase>, ok:true fellBack:true", async () => {
    exec
      .mockResolvedValueOnce(diskOk())
      .mockResolvedValueOnce(res("fatal: couldn't find remote ref engineer/del-399-x\nRC=128"))
      .mockResolvedValueOnce(res("Preparing worktree\nRC=0"));
    const r = await createRunWorktree({
      sandbox_id: "s", run_id: "m2", base: "engineer/del-399-x", fetchBase: true,
      defaultBase: "main",
    });
    expect(r).toMatchObject({ ok: true, path: "/home/user/wt-m2", branch: "_mt_wt_m2", fellBack: true });
    const fbCmd = lastWtCmd();
    expect(fbCmd).toMatch(/git .*worktree add -f -B .* origin\/.*main/);
    expect(fbCmd).not.toMatch(/git fetch /);
    expect(fbCmd).toMatch(/flock -w 60 \/tmp\/_praxis_wt\.lock/);
  });

  it("also falls back on 'not a valid object name' (older pre-fetch error shape)", async () => {
    exec
      .mockResolvedValueOnce(diskOk())
      .mockResolvedValueOnce(res("fatal: not a valid object name: 'origin/engineer/x'\nRC=255", 255))
      .mockResolvedValueOnce(res("done\nRC=0"));
    const r = await createRunWorktree({
      sandbox_id: "s", run_id: "m3", base: "engineer/x", fetchBase: true, defaultBase: "main",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected fallback success");
    expect(r.fellBack).toBe(true);
  });

  it("does NOT fall back on an AUTH failure (403) — only on a genuine missing-ref", async () => {
    exec.mockResolvedValue(
      res("fatal: unable to access '...': 403\nRC=128"),
    );
    const r = await createRunWorktree({
      sandbox_id: "s", run_id: "m4", base: "engineer/x", fetchBase: true, defaultBase: "main",
    });
    expect(r.ok).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("does NOT fall back when defaultBase == base (nothing to fall back to)", async () => {
    exec.mockResolvedValue(res("fatal: couldn't find remote ref main\nRC=128"));
    const r = await createRunWorktree({
      sandbox_id: "s", run_id: "m5", base: "main", fetchBase: true, defaultBase: "main",
    });
    expect(r.ok).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("redactGitCreds: scrubs credentialed URLs, leaves clean URLs untouched", () => {
    expect(redactGitCreds("err https://x-access-token:ghs_AAA@github.com/o/r.git x")).toBe(
      "err https://[redacted]@github.com/o/r.git x",
    );
    expect(redactGitCreds("https://user:pw@host/a and https://t:s@h2/b")).toBe(
      "https://[redacted]@host/a and https://[redacted]@h2/b",
    );
    expect(redactGitCreds("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
  });

  it("rejects an unsafe base before any exec", async () => {
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "x", base: "--evil; rm -rf" });
    expect(r.ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("invalid run_id → invalid_run_id, no exec", async () => {
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "$(){}", base: "main" });
    expect(r).toEqual({ ok: false, error: "invalid_run_id", code: "invalid_run_id" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("sanitizes a hostile run_id into a safe path (no traversal/injection)", async () => {
    const p = worktreePathFor("../../etc/$(whoami)");
    expect(p).toBe("/home/user/wt-....etcwhoami");
    expect(p).not.toContain("/..");
    expect(p).not.toContain("$(");
  });

  it("worktree add failure (nonzero RC) → ok:false", async () => {
    exec.mockResolvedValue(res("fatal: invalid reference\nRC=128"));
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "r1", base: "main" });
    expect(r.ok).toBe(false);
  });

  it("checkout TIMEOUT (e2b timed_out flag) → code worktree_timeout + retried once at same budget", async () => {
    const timeoutRes = {
      stdout: "Preparing worktree\nUpdating files: 42% (2438/6337)",
      stderr: "", exit_code: 1, ms: 240_000, timed_out: true,
    };
    exec.mockResolvedValue(timeoutRes);
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "to1", base: "main" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected timeout failure");
    expect(r.code).toBe("worktree_timeout");
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec.mock.calls[1][2]).toBe(240_000);
    expect(exec.mock.calls[2][2]).toBe(240_000);
  });

  it("checkout budget-consumed with no RC marker (no explicit flag) → treated as timeout + retried", async () => {
    exec.mockResolvedValue({
      stdout: "Updating files: 42% (2438/6337)", stderr: "", exit_code: 1, ms: 239_000,
    });
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "to2", base: "main" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected timeout");
    expect(r.code).toBe("worktree_timeout");
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("real git error (RC present, fast) → code worktree_git, NOT retried", async () => {
    exec.mockResolvedValue(res("fatal: invalid reference\nRC=128"));
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "ge1", base: "main" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected git error");
    expect(r.code).toBe("worktree_git");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("EARLY infra-kill (ms<budget, no RC, no timed_out flag) → worktree_timeout + NOT retried + C14-safe telemetry", async () => {
    exec.mockResolvedValue({
      stdout: "Preparing worktree\nUpdating files: 42% (2707/6334)",
      stderr: "Killed", exit_code: 137, ms: 90_000,
    });
    const r = await createRunWorktree({
      sandbox_id: "sb-9", run_id: "ek1", base: "main",
      tenant_id: "t-1", agent_slug: "engineer",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.code).toBe("worktree_timeout");
    expect(exec).toHaveBeenCalledTimes(2);
    expect(r.error).toContain("Killed");
    const classifyCalls = vi
      .mocked(logEvent)
      .mock.calls.map((c) => c[0])
      .filter((a) => a.code === "worktree_timeout");
    expect(classifyCalls).toHaveLength(1);
    const arg = classifyCalls[0];
    expect(arg.code).toBe("worktree_timeout");
    expect(arg.source).toBe("run-worktree");
    expect(arg.tenant_id).toBe("t-1");
    expect(arg.meta).toMatchObject({
      agent_slug: "engineer", exit_code: 137, timed_out: false,
      has_rc_marker: false, sandbox_id: "sb-9",
    });
    expect(JSON.stringify(arg.meta)).not.toMatch(/Updating files|Killed/);
  });

  it("a timed-out FIRST attempt that succeeds on retry → ok:true (transient blip recovered)", async () => {
    exec
      .mockResolvedValueOnce(diskOk())
      .mockResolvedValueOnce({
        stdout: "Updating files: 42% (2438/6337)", stderr: "", exit_code: 1,
        ms: 240_000, timed_out: true,
      })
      .mockResolvedValueOnce(res("Preparing worktree\nRC=0"))
      .mockResolvedValue(res(""));
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "to3", base: "main" });
    expect(r).toMatchObject({ ok: true, path: "/home/user/wt-to3", branch: "_mt_wt_to3" });
    const addCalls = exec.mock.calls.filter((c) => String(c[1]).includes("worktree add"));
    expect(addCalls.length).toBe(2);
  });

  it("removeRunWorktree issues flock'd remove + branch -D + prune for the run", async () => {
    exec.mockResolvedValue(res(""));
    await removeRunWorktree({ sandbox_id: "s", run_id: "r9" });
    const cmd = (exec.mock.calls[0][1] as string);
    expect(cmd).toContain("flock -w 60 /tmp/_praxis_wt.lock");
    expect(cmd).toContain("git worktree remove --force");
    expect(cmd).toContain("/home/user/wt-r9");
    expect(cmd).toContain("git branch -D");
    expect(cmd).toContain("_mt_wt_r9");
    expect(cmd).toContain("git worktree prune");
    expect(cmd).toContain("/home/user/.praxis/wt-leases/r9");
  });

  const porcelain = (...wtNames: string[]) =>
    "worktree /home/user/repo\nHEAD a\nbranch refs/heads/development\n\n" +
    wtNames.map((n) => `worktree /home/user/wt-${n}\nHEAD x\n`).join("\n") + "\n";

  it("reapOrphanWorktrees removes a MISSING-lease orphan not in keep, leaves main + kept", async () => {
    exec.mockImplementation((_id: unknown, cmd: unknown) => {
      const c = String(cmd);
      if (c.includes("worktree list --porcelain")) return Promise.resolve(res(porcelain("keepme", "orphan")));
      if (c.includes("stat -c %Y")) return Promise.resolve(res("MISSING"));
      if (c.includes("worktree remove")) return Promise.resolve(res("RC=0"));
      return Promise.resolve(res(""));
    });
    const r = await reapOrphanWorktrees({ sandbox_id: "s", keepRunIds: ["keepme"] });
    expect(r.removed).toEqual(["/home/user/wt-orphan"]);
    const removeCalls = exec.mock.calls.filter((c) => String(c[1]).includes("worktree remove"));
    expect(removeCalls.every((c) => !String(c[1]).includes("/home/user/repo'"))).toBe(true);
  });

  it("SKIPS a FRESH-lease worktree even when its run_id is ABSENT from keepRunIds (the race fix)", async () => {
    exec.mockImplementation((_id: unknown, cmd: unknown) => {
      const c = String(cmd);
      if (c.includes("worktree list --porcelain")) return Promise.resolve(res(porcelain("liverun")));
      if (c.includes("stat -c %Y")) return Promise.resolve(res("AGE=5"));
      if (c.includes("worktree remove")) return Promise.resolve(res("RC=0"));
      return Promise.resolve(res(""));
    });
    const r = await reapOrphanWorktrees({ sandbox_id: "s", keepRunIds: [] });
    expect(r.removed).toEqual([]);
    const removeCalls = exec.mock.calls.filter((c) => String(c[1]).includes("worktree remove"));
    expect(removeCalls.length).toBe(0);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "wt_reap_skip_live" }));
  });

  it("reaps a STALE-lease worktree (age > derived grace)", async () => {
    const staleSec = Math.ceil(WT_REAP_GRACE_MS / 1000) + 60;
    exec.mockImplementation((_id: unknown, cmd: unknown) => {
      const c = String(cmd);
      if (c.includes("worktree list --porcelain")) return Promise.resolve(res(porcelain("deadrun")));
      if (c.includes("stat -c %Y")) return Promise.resolve(res(`AGE=${staleSec}`));
      if (c.includes("worktree remove")) return Promise.resolve(res("RC=0"));
      return Promise.resolve(res(""));
    });
    const r = await reapOrphanWorktrees({ sandbox_id: "s", keepRunIds: [] });
    expect(r.removed).toEqual(["/home/user/wt-deadrun"]);
  });

  it("SKIPS on a lease PROBE ERROR (lease exists but stat failed) — never reaps when it can't prove the run is dead", async () => {
    exec.mockImplementation((_id: unknown, cmd: unknown) => {
      const c = String(cmd);
      if (c.includes("worktree list --porcelain")) return Promise.resolve(res(porcelain("unknown")));
      if (c.includes("stat -c %Y")) return Promise.resolve(res("PROBE_ERROR"));
      if (c.includes("worktree remove")) return Promise.resolve(res("RC=0"));
      return Promise.resolve(res(""));
    });
    const r = await reapOrphanWorktrees({ sandbox_id: "s", keepRunIds: [] });
    expect(r.removed).toEqual([]);
    const removeCalls = exec.mock.calls.filter((c) => String(c[1]).includes("worktree remove"));
    expect(removeCalls.length).toBe(0);
  });

  it("WT_REAP_GRACE_MS is DERIVED from the run hard cap (never below max run lifetime)", () => {
    expect(WT_REAP_GRACE_MS).toBeGreaterThan(2 * 60 * 60 * 1000);
  });

  it("createRunWorktree writes the out-of-tree liveness lease before returning ok (main path)", async () => {
    exec.mockResolvedValue(res("Preparing worktree\nRC=0"));
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "rL", base: "main" });
    expect(r.ok).toBe(true);
    const leaseWrite = exec.mock.calls.find((c) => String(c[1]).includes("/home/user/.praxis/wt-leases/rL"));
    expect(leaseWrite).toBeTruthy();
    expect(String(leaseWrite![1])).toContain("mkdir -p");
  });

  it("createRunWorktree writes the lease on the FALLBACK add path too", async () => {
    exec
      .mockResolvedValueOnce(diskOk())
      .mockResolvedValueOnce(res("fatal: couldn't find remote ref engineer/x\nRC=128"))
      .mockResolvedValueOnce(res("Preparing worktree\nRC=0"))
      .mockResolvedValue(res(""));
    const r = await createRunWorktree({
      sandbox_id: "s", run_id: "rF", base: "engineer/x", fetchBase: true, defaultBase: "main",
    });
    expect(r.ok).toBe(true);
    expect((r as { fellBack?: boolean }).fellBack).toBe(true);
    const leaseWrite = exec.mock.calls.find((c) => String(c[1]).includes("/home/user/.praxis/wt-leases/rF"));
    expect(leaseWrite).toBeTruthy();
  });

  it("preflight insufficient disk → worktree_insufficient_disk, NO worktree add attempted", async () => {
    exec.mockResolvedValue(
      res("FREE=1000 REPO=9000000 GIT=100 TRACKED=8000000 BLOBS=5000 LFS=0 REFKIND=origin_base"),
    );
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "big1", base: "main" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected insufficient_disk");
    expect(r.code).toBe("worktree_insufficient_disk");
    expect(r.error).toMatch(/insufficient_disk/);
    expect(r.error).not.toMatch(/larger sandbox|larger tier|resiz/i);
    expect(r.error).toMatch(/tracked files/);
    expect(r.treeKb).toBe(8_999_900);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls.some((c) => String(c[1]).includes("worktree add"))).toBe(false);
  });

  it("prod incident: 3.2GB footprint but 330MB tracked, 3.9GB free → PROCEEDS", async () => {
    exec
      .mockResolvedValueOnce(
        res(
          "FREE=4040704 REPO=3760128 GIT=450560 TRACKED=338016 BLOBS=5791 LFS=0 REFKIND=origin_base",
        ),
      )
      .mockResolvedValueOnce(res("Preparing worktree\nRC=0"));
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "inc1", base: "main" });
    expect(r.ok).toBe(true);
    expect(exec.mock.calls.some((c) => String(c[1]).includes("worktree add"))).toBe(true);
    if (r.ok) expect(r.treeKb).toBe(3_309_568);
  });

  it("preflight measures TRACKED via ls-tree, not du of the working dir", async () => {
    exec
      .mockResolvedValueOnce(res("FREE=50000000 REPO=1000 GIT=400 TRACKED=100 BLOBS=10"))
      .mockResolvedValueOnce(res("Preparing worktree\nRC=0"));
    await createRunWorktree({ sandbox_id: "s", run_id: "probe1", base: "main" });
    const probeCmd = String(exec.mock.calls[0][1]);
    expect(probeCmd).toMatch(/ls-tree -r -l/);
    expect(probeCmd).toMatch(/\$2=="blob"/);
    expect(probeCmd).toMatch(/du -sxk/);
    expect(probeCmd).toMatch(/REF=origin\/'main'/);
    expect(probeCmd).toMatch(/REF=HEAD/);
  });

  it("BLOBS*4 floor blocks a many-tiny-files repo that apparent-bytes alone would pass", async () => {
    exec.mockResolvedValue(
      res("FREE=600000 REPO=900000 GIT=100000 TRACKED=50000 BLOBS=200000 LFS=0 REFKIND=head"),
    );
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "tiny1", base: "main" });
    expect(r.ok).toBe(false);
    expect(exec.mock.calls.some((c) => String(c[1]).includes("worktree add"))).toBe(false);
  });

  it("TRACKED unparseable → checkout gate SKIPPED but treeKb still returned", async () => {
    exec
      .mockResolvedValueOnce(res("FREE=1000 REPO=9000000 GIT=100 REFKIND=none"))
      .mockResolvedValueOnce(res("Preparing worktree\nRC=0"));
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "notrk", base: "main" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.treeKb).toBe(8_999_900);
    expect(exec.mock.calls.some((c) => String(c[1]).includes("worktree add"))).toBe(true);
  });

  it("empty tree (BLOBS=0) → fail open, never blocks", async () => {
    exec
      .mockResolvedValueOnce(res("FREE=1000 REPO=9000000 GIT=100 TRACKED=0 BLOBS=0"))
      .mockResolvedValueOnce(res("Preparing worktree\nRC=0"));
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "empt1", base: "main" });
    expect(r.ok).toBe(true);
  });

  it("logs disk telemetry as counters + a ref-kind ENUM, never a branch name", async () => {
    exec
      .mockResolvedValueOnce(
        res("FREE=50000000 REPO=1000 GIT=400 TRACKED=100 BLOBS=10 LFS=0 REFKIND=origin_base"),
      )
      .mockResolvedValueOnce(res("Preparing worktree\nRC=0"));
    await createRunWorktree({ sandbox_id: "s", run_id: "log1", base: "release/secret-name" });
    const call = vi
      .mocked(logEvent)
      .mock.calls.map((c) => c[0])
      .find((a) => a.code === "sandbox.worktree_preflight");
    expect(call).toBeTruthy();
    expect(call?.meta).toMatchObject({ probe_ref_kind: "origin_base", checkout_kb: 100 });
    expect(JSON.stringify(call?.meta ?? {})).not.toMatch(/secret-name/);
  });

  it("preflight sufficient disk → proceeds to worktree add", async () => {
    exec
      .mockResolvedValueOnce(res("FREE=50000000 REPO=1000 GIT=400"))
      .mockResolvedValueOnce(res("Preparing worktree\nRC=0"));
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "ok1", base: "main" });
    expect(r).toMatchObject({ ok: true, path: "/home/user/wt-ok1", branch: "_mt_wt_ok1" });
    if (r.ok) expect(r.treeKb).toBe(600);
    expect(exec.mock.calls.some((c) => String(c[1]).includes("worktree add"))).toBe(true);
  });

  it("mid-checkout ENOSPC (preflight passed, add fills disk) → worktree_insufficient_disk + treeKb", async () => {
    exec
      .mockResolvedValueOnce(res("FREE=99999999 REPO=1000 GIT=400"))
      .mockResolvedValueOnce(
        res(
          "Preparing worktree\nUpdating files: 90%\n" +
            "error: unable to write file x\nfatal: cannot create directory: No space left on device\nRC=128",
          128,
        ),
      );
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "en1", base: "main" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected ENOSPC failure");
    expect(r.code).toBe("worktree_insufficient_disk");
    expect(r.treeKb).toBe(600);
  });

  it("preflight FAIL-OPEN: an unparseable probe never blocks (proceeds to add)", async () => {
    exec
      .mockResolvedValueOnce(res("df: /home/user/repo: cannot read"))
      .mockResolvedValueOnce(res("Preparing worktree\nRC=0"));
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "fo1", base: "main" });
    expect(r.ok).toBe(true);
    expect(exec.mock.calls.some((c) => String(c[1]).includes("worktree add"))).toBe(true);
  });
});
