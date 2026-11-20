import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LiveEditError,
  invalidateLiveEditState,
  readLiveEditState,
  wakeLiveEditPreview,
  type LiveEditDeps,
  type WakeDeps,
} from "@/services/build/live-edit";

const T = "tenant-wake";
const TARGET = { github_full_name: "praxis-built/acme-1234", default_branch: "main" };
const HEAD = "d".repeat(40);
const HANDLE = { row_id: "row-w", e2b_sandbox_id: "sb-w" };

type Fn = ReturnType<typeof vi.fn>;

function deps(over: Partial<LiveEditDeps> = {}): LiveEditDeps & Record<keyof LiveEditDeps, Fn> {
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
    hasActiveBuild: vi.fn().mockResolvedValue(false),
    loadPreviewRow: vi.fn().mockResolvedValue({
      id: "row-w",
      e2b_sandbox_id: "sb-w",
      preview_status: "live",
      preview_url: "https://3000-sb-w.e2b.app",
      preview_port: 3000,
      preview_run_id: "live-edit:wake",
    }),
    clearPreview: vi.fn().mockResolvedValue(undefined),
    touchPreview: vi.fn().mockResolvedValue(undefined),
    now: vi.fn(() => 1),
    ...over,
  } as never;
}

function wake(over: Partial<WakeDeps> = {}): WakeDeps & Record<keyof WakeDeps, Fn> {
  return {
    installationToken: vi.fn().mockResolvedValue("ghs_tok"),
    resolveSandbox: vi.fn().mockResolvedValue(HANDLE),
    injectToken: vi.fn().mockResolvedValue(undefined),
    bootstrap: vi.fn().mockResolvedValue(undefined),
    checkout: vi.fn().mockResolvedValue({ ok: true, sha: HEAD }),
    wipe: vi.fn().mockResolvedValue(undefined),
    ensurePreview: vi.fn().mockResolvedValue({ url: "https://3000-sb-w.e2b.app", reused: false, reason: "booted" }),
    pause: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as never;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof LiveEditError ? `${e.code}:${e.status}` : `raw:${(e as Error).message}`;
  }
  return "resolved";
}

beforeEach(() => invalidateLiveEditState(T));

describe("wakeLiveEditPreview never leaves a resumed sandbox running after a failed wake", () => {
  it("pauses the sandbox when the fleet cap refuses the preview", async () => {
    const d = deps();
    const w = wake({ ensurePreview: vi.fn().mockResolvedValue({ url: null, reused: false, reason: "capacity" }) });
    expect(await codeOf(wakeLiveEditPreview(T, d, w))).toBe("capacity:503");
    expect(w.pause).toHaveBeenCalledTimes(1);
    expect(w.pause).toHaveBeenCalledWith(HANDLE);
  });

  it("pauses the sandbox when the dev server fails to boot, and reports the failure", async () => {
    const w = wake({ ensurePreview: vi.fn().mockResolvedValue({ url: null, reused: false, reason: "boot_failed" }) });
    expect(await codeOf(wakeLiveEditPreview(T, deps(), w))).toBe("no_sandbox:502");
    expect(w.pause).toHaveBeenCalledWith(HANDLE);
  });

  it("pauses the sandbox when the preview boot throws", async () => {
    const w = wake({ ensurePreview: vi.fn().mockRejectedValue(new Error("e2b exec timeout")) });
    expect(await codeOf(wakeLiveEditPreview(T, deps(), w))).toBe("raw:e2b exec timeout");
    expect(w.pause).toHaveBeenCalledWith(HANDLE);
  });

  it("pauses the sandbox and wipes the token when the draft checkout fails", async () => {
    const w = wake({ checkout: vi.fn().mockResolvedValue({ ok: false, reason: "lock" }) });
    expect(await codeOf(wakeLiveEditPreview(T, deps(), w))).toBe("no_sandbox:502");
    expect(w.wipe).toHaveBeenCalledWith("sb-w");
    expect(w.ensurePreview).not.toHaveBeenCalled();
    expect(w.pause).toHaveBeenCalledWith(HANDLE);
    expect(w.wipe.mock.invocationCallOrder[0]).toBeLessThan(w.pause.mock.invocationCallOrder[0]);
  });

  it("never runs the dependency install when removing the GitHub token fails", async () => {
    const w = wake({ wipe: vi.fn().mockRejectedValue(new Error("setEnv failed")) });
    expect(await codeOf(wakeLiveEditPreview(T, deps(), w))).toBe("no_sandbox:502");
    expect(w.ensurePreview).not.toHaveBeenCalled();
    expect(w.pause).toHaveBeenCalledWith(HANDLE, { force: true });
  });

  it("a failed wipe force-pauses even when a build started on the sandbox mid-wake", async () => {
    const d = deps({ hasActiveBuild: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true) });
    const w = wake({ wipe: vi.fn().mockRejectedValue(new Error("setEnv failed")) });
    expect(await codeOf(wakeLiveEditPreview(T, d, w))).toBe("build_in_progress:409");
    expect(w.pause).toHaveBeenCalledWith(HANDLE, { force: true });
  });

  it("a normal failed wake pauses without forcing past a live preview", async () => {
    const w = wake({ ensurePreview: vi.fn().mockResolvedValue({ url: null, reused: false, reason: "boot_failed" }) });
    await codeOf(wakeLiveEditPreview(T, deps(), w));
    expect(w.pause.mock.calls[0]).toEqual([HANDLE]);
  });

  it("pauses the sandbox when the repo clone or the token injection fails", async () => {
    const clone = wake({ bootstrap: vi.fn().mockRejectedValue(new Error("cloneRepo failed exit=128")) });
    expect(await codeOf(wakeLiveEditPreview(T, deps(), clone))).toBe("raw:cloneRepo failed exit=128");
    expect(clone.pause).toHaveBeenCalledWith(HANDLE);

    const inject = wake({ injectToken: vi.fn().mockRejectedValue(new Error("setEnv failed")) });
    expect(await codeOf(wakeLiveEditPreview(T, deps(), inject))).toBe("raw:setEnv failed");
    expect(inject.pause).toHaveBeenCalledWith(HANDLE);
  });

  it("still surfaces the wake error when the cleanup pause itself fails", async () => {
    const w = wake({
      ensurePreview: vi.fn().mockResolvedValue({ url: null, reused: false, reason: "capacity" }),
      pause: vi.fn().mockRejectedValue(new Error("pause 500")),
    });
    expect(await codeOf(wakeLiveEditPreview(T, deps(), w))).toBe("capacity:503");
  });

  it("never pauses a sandbox a change started using mid-wake", async () => {
    const d = deps({ hasActiveBuild: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true) });
    const w = wake();
    expect(await codeOf(wakeLiveEditPreview(T, d, w))).toBe("build_in_progress:409");
    expect(w.checkout).not.toHaveBeenCalled();
    expect(w.pause).not.toHaveBeenCalled();
  });

  it("leaves the sandbox alone when a change starts between the failure and the cleanup, or the check errors", async () => {
    const started = deps({
      hasActiveBuild: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true),
    });
    const w1 = wake({ checkout: vi.fn().mockResolvedValue({ ok: false, reason: "fetch" }) });
    expect(await codeOf(wakeLiveEditPreview(T, started, w1))).toBe("no_sandbox:502");
    expect(w1.pause).not.toHaveBeenCalled();

    invalidateLiveEditState(T);
    const unreadable = deps({
      hasActiveBuild: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockRejectedValue(new Error("db down")),
    });
    const w2 = wake({ checkout: vi.fn().mockResolvedValue({ ok: false, reason: "fetch" }) });
    expect(await codeOf(wakeLiveEditPreview(T, unreadable, w2))).toBe("no_sandbox:502");
    expect(w2.pause).not.toHaveBeenCalled();
  });

  it("does not pause a sandbox that is now serving the woken preview", async () => {
    const w = wake();
    expect(await wakeLiveEditPreview(T, deps(), w)).toEqual({ url: "https://3000-sb-w.e2b.app" });
    expect(w.pause).not.toHaveBeenCalled();
  });
});

describe("wakeLiveEditPreview refuses a draft that fell behind main", () => {
  it("answers 409 draft_behind before any sandbox is resumed, even when a stale cached compare said otherwise", async () => {
    const compare = vi
      .fn()
      .mockResolvedValueOnce({ ahead_by: 1, behind_by: 0, commits: [] })
      .mockResolvedValue({ ahead_by: 1, behind_by: 2, commits: [] });
    const d = deps({ compare });
    await readLiveEditState(T, d);
    const w = wake();
    expect(await codeOf(wakeLiveEditPreview(T, d, w))).toBe("draft_behind:409");
    expect(w.installationToken).not.toHaveBeenCalled();
    expect(w.resolveSandbox).not.toHaveBeenCalled();
    expect(w.pause).not.toHaveBeenCalled();
  });

  it("does not resume a sandbox when the draft read fails", async () => {
    const d = deps({ compare: vi.fn().mockRejectedValue(new Error("compare HTTP 502")) });
    const w = wake();
    expect(await codeOf(wakeLiveEditPreview(T, d, w))).toBe("raw:compare HTTP 502");
    expect(w.resolveSandbox).not.toHaveBeenCalled();
  });
});

describe("readLiveEditState only refreshes the idle clock when the caller frames the preview", () => {
  it("a background status poll never keeps the paid sandbox awake", async () => {
    const d = deps();
    for (let i = 0; i < 5; i++) {
      invalidateLiveEditState(T);
      const s = await readLiveEditState(T, d);
      expect(s.preview.status).toBe("live");
    }
    expect(d.touchPreview).not.toHaveBeenCalled();
  });

  it("an unframed poll during a running change does not touch either", async () => {
    const d = deps({ hasActiveBuild: vi.fn().mockResolvedValue(true) });
    await readLiveEditState(T, d, { framed: false });
    expect(d.touchPreview).not.toHaveBeenCalled();
  });

  it("a framed poll of a pending draft does touch", async () => {
    const d = deps();
    await readLiveEditState(T, d, { framed: true });
    expect(d.touchPreview).toHaveBeenCalledWith("row-w");
  });
});
