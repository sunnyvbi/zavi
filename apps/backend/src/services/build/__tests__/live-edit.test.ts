import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_EDIT_BRANCH,
  LiveEditError,
  buildDraftCheckoutScript,
  discardDraft,
  discardDraftForNewBuild,
  ensureLiveEditPreview,
  invalidateLiveEditState,
  isLiveEditPayload,
  parseDraftCheckout,
  publishDraft,
  readLiveEditState,
  type EnsurePreviewDeps,
  type LiveEditDeps,
} from "@/services/build/live-edit";
import { shouldKeepWarm } from "@/services/sandbox/lifecycle";

const T = "tenant-1";
const TARGET = { github_full_name: "praxis-built/acme-1234", default_branch: "main" };
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

type Mocked = { [K in keyof LiveEditDeps]: ReturnType<typeof vi.fn> } & LiveEditDeps;

function deps(over: Partial<LiveEditDeps> = {}, clock = { t: 1_000_000 }): Mocked {
  return {
    enabled: vi.fn().mockResolvedValue(true),
    loadTarget: vi.fn().mockResolvedValue(TARGET),
    assertProvisioned: vi.fn().mockResolvedValue(true),
    installation: vi.fn().mockResolvedValue(-1),
    compare: vi.fn().mockResolvedValue({ ahead_by: 2, behind_by: 0, commits: [{ sha: OLD, message: "one" }, { sha: NEW, message: "two" }] }),
    branchSha: vi.fn().mockResolvedValue(NEW),
    changedFiles: vi.fn().mockResolvedValue(["app/page.tsx"]),
    protectedGlobs: vi.fn().mockResolvedValue(["**/.env*"]),
    fastForward: vi.fn().mockResolvedValue(undefined),
    deleteBranch: vi.fn().mockResolvedValue(true),
    hasActiveBuild: vi.fn().mockResolvedValue(false),
    loadPreviewRow: vi.fn().mockResolvedValue({ id: "row1", e2b_sandbox_id: "sb1", preview_status: "live", preview_url: "https://3000-sb1.e2b.app", preview_port: 3000 }),
    clearPreview: vi.fn().mockResolvedValue(undefined),
    touchPreview: vi.fn().mockResolvedValue(undefined),
    now: vi.fn(() => clock.t),
    ...over,
  } as unknown as Mocked;
}

beforeEach(() => {
  invalidateLiveEditState(T);
});

describe("publishDraft", () => {
  it("fast-forwards the default branch to the draft head, never force", async () => {
    const d = deps();
    const out = await publishDraft(T, d);
    expect(out).toEqual({ commit_sha: NEW, published: 2 });
    expect(d.fastForward).toHaveBeenCalledTimes(1);
    expect(d.fastForward).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "praxis-built", repo: "acme-1234", branch: "main", to_sha: NEW }),
    );
  });

  it("re-reads the draft instead of trusting a cached head, so a stale sha is never published", async () => {
    const clock = { t: 1_000_000 };
    const d = deps({ branchSha: vi.fn().mockResolvedValueOnce(OLD).mockResolvedValue(NEW) }, clock);
    const state = await readLiveEditState(T, d);
    expect(state.draft.head_sha).toBe(OLD);
    clock.t += 1_000;
    await publishDraft(T, d);
    expect(d.fastForward).toHaveBeenCalledWith(expect.objectContaining({ to_sha: NEW }));
    expect(d.fastForward).not.toHaveBeenCalledWith(expect.objectContaining({ to_sha: OLD }));
  });

  it("refuses when main moved past the draft and writes nothing", async () => {
    const d = deps({ compare: vi.fn().mockResolvedValue({ ahead_by: 1, behind_by: 1, commits: [{ sha: NEW, message: "x" }] }) });
    await expect(publishDraft(T, d)).rejects.toMatchObject({ code: "draft_behind", status: 409 });
    expect(d.fastForward).not.toHaveBeenCalled();
  });

  it("refuses while a build or change is running and never touches GitHub refs", async () => {
    const d = deps({ hasActiveBuild: vi.fn().mockResolvedValue(true) });
    await expect(publishDraft(T, d)).rejects.toMatchObject({ code: "build_in_progress" });
    expect(d.fastForward).not.toHaveBeenCalled();
    expect(d.compare).not.toHaveBeenCalled();
  });

  it("refuses with no GitHub call at all when the flag is off", async () => {
    const d = deps({ enabled: vi.fn().mockResolvedValue(false) });
    await expect(publishDraft(T, d)).rejects.toBeInstanceOf(LiveEditError);
    expect(d.installation).not.toHaveBeenCalled();
    expect(d.branchSha).not.toHaveBeenCalled();
    expect(d.fastForward).not.toHaveBeenCalled();
  });

  it("refuses a repo that is not this tenant's provisioned app", async () => {
    const d = deps({ assertProvisioned: vi.fn().mockResolvedValue(false) });
    await expect(publishDraft(T, d)).rejects.toMatchObject({ code: "not_provisioned" });
    expect(d.fastForward).not.toHaveBeenCalled();
  });

  it("reports nothing to publish when there is no draft branch", async () => {
    const d = deps({ branchSha: vi.fn().mockResolvedValue(null) });
    await expect(publishDraft(T, d)).rejects.toMatchObject({ code: "nothing_to_publish" });
    expect(d.compare).not.toHaveBeenCalled();
    expect(d.fastForward).not.toHaveBeenCalled();
  });

  it("a successful publish asks for a static republish of the published head, after main moved", async () => {
    const order: string[] = [];
    const requestStaticPublish = vi.fn(async () => {
      order.push("static");
    });
    const d = deps({
      requestStaticPublish,
      fastForward: vi.fn(async () => {
        order.push("ff");
      }),
    });
    await publishDraft(T, d);
    expect(requestStaticPublish).toHaveBeenCalledTimes(1);
    expect(requestStaticPublish).toHaveBeenCalledWith({ tenant_id: T, sha: NEW });
    expect(order).toEqual(["ff", "static"]);
  });

  it("a refused or failed publish never asks for a static republish, and a failed request never fails the publish", async () => {
    const requestStaticPublish = vi.fn().mockRejectedValue(new Error("inngest down"));
    const refused = deps({ requestStaticPublish, hasActiveBuild: vi.fn().mockResolvedValue(true) });
    await expect(publishDraft(T, refused)).rejects.toMatchObject({ code: "build_in_progress" });
    const rejected = deps({
      requestStaticPublish,
      fastForward: vi.fn().mockRejectedValue(Object.assign(new Error("422"), { code: "fast_forward_rejected" })),
    });
    await expect(publishDraft(T, rejected)).rejects.toMatchObject({ code: "fast_forward_rejected" });
    expect(requestStaticPublish).not.toHaveBeenCalled();
    invalidateLiveEditState(T);
    await expect(publishDraft(T, deps({ requestStaticPublish }))).resolves.toEqual({ commit_sha: NEW, published: 2 });
    expect(requestStaticPublish).toHaveBeenCalledTimes(1);
  });

  it("the real deps wire the static republish request", async () => {
    const { realLiveEditDeps } = await import("@/services/build/live-edit");
    expect(typeof realLiveEditDeps.requestStaticPublish).toBe("function");
  });

  it("propagates a rejected fast-forward (main moved between compare and write)", async () => {
    const d = deps({ fastForward: vi.fn().mockRejectedValue(Object.assign(new Error("422"), { code: "fast_forward_rejected" })) });
    await expect(publishDraft(T, d)).rejects.toMatchObject({ code: "fast_forward_rejected" });
  });
});

describe("discardDraft", () => {
  it("deletes only the draft branch and takes the preview down", async () => {
    const d = deps();
    await discardDraft(T, d);
    expect(d.deleteBranch).toHaveBeenCalledWith(expect.objectContaining({ branch: LIVE_EDIT_BRANCH }));
    expect(d.deleteBranch).not.toHaveBeenCalledWith(expect.objectContaining({ branch: "main" }));
    expect(d.clearPreview).toHaveBeenCalledWith("row1");
  });

  it("refuses while a change is running", async () => {
    const d = deps({ hasActiveBuild: vi.fn().mockResolvedValue(true) });
    await expect(discardDraft(T, d)).rejects.toMatchObject({ code: "build_in_progress" });
    expect(d.deleteBranch).not.toHaveBeenCalled();
  });
});

describe("readLiveEditState", () => {
  it("is inert when the flag is off", async () => {
    const d = deps({ enabled: vi.fn().mockResolvedValue(false) });
    const s = await readLiveEditState(T, d);
    expect(s.enabled).toBe(false);
    expect(d.loadTarget).not.toHaveBeenCalled();
    expect(d.branchSha).not.toHaveBeenCalled();
  });

  it("serves GitHub reads from cache for a few seconds, and a publish invalidates it", async () => {
    const clock = { t: 1_000_000 };
    const d = deps({}, clock);
    await readLiveEditState(T, d);
    clock.t += 2_000;
    await readLiveEditState(T, d);
    expect(d.branchSha).toHaveBeenCalledTimes(1);
    await publishDraft(T, d);
    expect(d.branchSha).toHaveBeenCalledTimes(2);
    clock.t += 100;
    await readLiveEditState(T, d);
    expect(d.branchSha).toHaveBeenCalledTimes(3);
  });

  it("only exposes a live preview url and touches the idle clock while serving it", async () => {
    const d = deps();
    const s = await readLiveEditState(T, d, { framed: true });
    expect(s.preview).toEqual({ status: "live", url: "https://3000-sb1.e2b.app" });
    expect(s.draft).toMatchObject({ exists: true, ahead_by: 2, head_sha: NEW });
    expect(s.draft.changes.map((c) => c.message)).toEqual(["two", "one"]);
    expect(d.touchPreview).toHaveBeenCalledWith("row1");

    const dead = deps({ loadPreviewRow: vi.fn().mockResolvedValue({ id: "row1", e2b_sandbox_id: "sb1", preview_status: "dead", preview_url: "https://3000-sb1.e2b.app", preview_port: 3000 }) });
    invalidateLiveEditState(T);
    const s2 = await readLiveEditState(T, dead);
    expect(s2.preview).toEqual({ status: "none", url: null });
    expect(dead.touchPreview).not.toHaveBeenCalled();
  });
});

describe("draft checkout script", () => {
  it("checks out the remote draft when it exists, otherwise branches the draft from the default branch", () => {
    const script = buildDraftCheckoutScript("main");
    expect(script).toContain("git fetch --prune origin");
    expect(script).toContain("git rev-parse --verify -q 'refs/remotes/origin/zavi/draft'");
    expect(script).toContain("git checkout -q -f -B 'zavi/draft' 'origin/zavi/draft'");
    expect(script).toContain("git checkout -q -f -B 'zavi/draft' 'origin/main'");
    expect(script).toContain("flock -w 60 9");
  });

  it("loads the draft even when the preview's dev server left the tree dirty", () => {
    const root = mkdtempSync(join(tmpdir(), "draft-co-"));
    const sh = (cmd: string, cwd = root) => execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" });
    try {
      sh("git init -q -b main origin && cd origin && git config user.email t@t && git config user.name t && printf main > tsconfig.json && git add . && git commit -qm main && git checkout -qb zavi/draft && printf draft > tsconfig.json && printf new > orders.tsx && git add . && git commit -qm draft && git checkout -q main");
      sh("git clone -q origin repo");
      const repo = join(root, "repo");
      writeFileSync(join(repo, "tsconfig.json"), "rewritten by next dev");
      const script = buildDraftCheckoutScript("main", repo)
        .split("\n")
        .map((line) => (line.includes("flock") ? "true" : line.replace(/^\{ \{ __zu=.*?false; \}; \} && /, "")))
        .join("\n");
      const out = execSync("bash -s", { cwd: root, input: script, encoding: "utf-8" });
      const draftSha = sh("git rev-parse zavi/draft", join(root, "origin")).trim();
      expect(parseDraftCheckout(out)).toEqual({ ok: true, sha: draftSha });
      expect(readFileSync(join(repo, "orders.tsx"), "utf-8")).toBe("new");
      expect(readFileSync(join(repo, "tsconfig.json"), "utf-8")).toBe("draft");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("quotes a hostile default branch", () => {
    const script = buildDraftCheckoutScript("main'; rm -rf / #");
    expect(script).toContain(`'origin/main'\\''; rm -rf / #'`);
  });

  it("parses success and every failure sentinel", () => {
    expect(parseDraftCheckout(`noise\n__DRAFT__OK:${NEW}\n`)).toEqual({ ok: true, sha: NEW });
    expect(parseDraftCheckout("__DRAFT__FETCH")).toEqual({ ok: false, reason: "fetch" });
    expect(parseDraftCheckout("")).toEqual({ ok: false, reason: "unknown" });
    expect(parseDraftCheckout("__DRAFT__OK:short")).toEqual({ ok: false, reason: "ok" });
  });
});

describe("isLiveEditPayload", () => {
  it("only matches the exact draft branch", () => {
    expect(isLiveEditPayload({ live_edit_branch: "zavi/draft" })).toBe(true);
    expect(isLiveEditPayload({ live_edit_branch: "main" })).toBe(false);
    expect(isLiveEditPayload({ live_edit_branch: true })).toBe(false);
    expect(isLiveEditPayload(null)).toBe(false);
  });
});

describe("ensureLiveEditPreview", () => {
  type PMocked = { [K in keyof EnsurePreviewDeps]: ReturnType<typeof vi.fn> } & EnsurePreviewDeps;
  const LIVE_ROW = { id: "row1", e2b_sandbox_id: "sb1", preview_status: "live", preview_url: "https://3000-sb1.e2b.app", preview_port: 3000, preview_run_id: "live-edit:run-1" };
  function pdeps(over: Partial<EnsurePreviewDeps> = {}): PMocked {
    return {
      loadPreviewRow: vi.fn().mockResolvedValue(LIVE_ROW),
      exec: vi.fn().mockResolvedValue({ stdout: "200", stderr: "", exit_code: 0 }),
      setPreview: vi.fn().mockResolvedValue(undefined),
      clearPreview: vi.fn().mockResolvedValue(undefined),
      startServer: vi.fn().mockResolvedValue({ url: "https://3000-sb1.e2b.app", port: 3000 }),
      hostFor: vi.fn().mockResolvedValue("https://3000-sb1.e2b.app"),
      countFleetPreviews: vi.fn().mockResolvedValue(0),
      ...over,
    } as unknown as PMocked;
  }
  const input = { tenant_id: T, repo_full_name: TARGET.github_full_name, sandbox_id: "sb1", run_id: "run-9" };
  const dead = { ...LIVE_ROW, preview_status: "dead" };

  it("reuses a dev server that still answers instead of starting a second one", async () => {
    const d = pdeps();
    const out = await ensureLiveEditPreview(input, d);
    expect(out).toMatchObject({ url: "https://3000-sb1.e2b.app", reused: true, reason: "reused" });
    expect(d.startServer).not.toHaveBeenCalled();
    expect(d.setPreview).not.toHaveBeenCalled();
  });

  it("a reaped (paused) preview whose server answers after resume is marked live again without a reboot", async () => {
    const d = pdeps({ loadPreviewRow: vi.fn().mockResolvedValue(dead) });
    const out = await ensureLiveEditPreview(input, d);
    expect(out.reason).toBe("reused");
    expect(d.startServer).not.toHaveBeenCalled();
    expect(d.setPreview.mock.calls.map((c) => [c[3], c[4]])).toEqual([
      ["starting", "live-edit:run-9"],
      ["live", "live-edit:run-9"],
    ]);
  });

  it("boots with the live-edit reaper marker so the 5-minute reaper owns it", async () => {
    const d = pdeps({ exec: vi.fn().mockResolvedValue({ stdout: "000", stderr: "", exit_code: 7 }) });
    const out = await ensureLiveEditPreview({ ...input, install: true }, d);
    expect(out.reason).toBe("booted");
    expect(d.startServer).toHaveBeenCalledWith("sb1", true);
    expect(d.setPreview.mock.calls.map((c) => [c[3], c[4]])).toEqual([
      ["starting", "live-edit:run-9"],
      ["live", "live-edit:run-9"],
    ]);
  });

  it("never reuses a row that belongs to a different sandbox", async () => {
    const d = pdeps({ loadPreviewRow: vi.fn().mockResolvedValue({ ...LIVE_ROW, e2b_sandbox_id: "sb-old" }) });
    await ensureLiveEditPreview(input, d);
    expect(d.exec).not.toHaveBeenCalled();
    expect(d.startServer).toHaveBeenCalledWith("sb1", false);
  });

  it("refuses to boot at fleet capacity and touches nothing", async () => {
    const d = pdeps({
      loadPreviewRow: vi.fn().mockResolvedValue(dead),
      exec: vi.fn().mockResolvedValue({ stdout: "000", stderr: "", exit_code: 7 }),
      countFleetPreviews: vi.fn().mockResolvedValue(30),
    });
    const out = await ensureLiveEditPreview(input, d);
    expect(out).toEqual({ url: null, reused: false, reason: "capacity" });
    expect(d.setPreview).not.toHaveBeenCalled();
    expect(d.startServer).not.toHaveBeenCalled();
  });

  it("treats an unreadable fleet count as full (fail closed on cost)", async () => {
    const d = pdeps({
      exec: vi.fn().mockResolvedValue({ stdout: "000", stderr: "", exit_code: 7 }),
      countFleetPreviews: vi.fn().mockRejectedValue(new Error("db down")),
    });
    const out = await ensureLiveEditPreview(input, d);
    expect(out.reason).toBe("capacity");
    expect(d.startServer).not.toHaveBeenCalled();
  });

  it("clears the row when the boot fails so the sandbox is not held awake", async () => {
    const d = pdeps({
      exec: vi.fn().mockRejectedValue(new Error("down")),
      startServer: vi.fn().mockRejectedValue(new Error("boot timeout")),
    });
    const out = await ensureLiveEditPreview(input, d);
    expect(out).toEqual({ url: null, reused: false, reason: "boot_failed" });
    expect(d.clearPreview).toHaveBeenCalledWith("row1");
    expect(d.setPreview.mock.calls.map((c) => c[3])).toEqual(["starting"]);
  });

  it("two kicks at once boot one server", async () => {
    let release!: (v: { url: string; port: number }) => void;
    const d = pdeps({
      exec: vi.fn().mockResolvedValue({ stdout: "000", stderr: "", exit_code: 7 }),
      startServer: vi.fn(() => new Promise<{ url: string; port: number }>((r) => (release = r))),
    });
    const a = ensureLiveEditPreview(input, d);
    const b = ensureLiveEditPreview(input, d);
    await new Promise((r) => setImmediate(r));
    release({ url: "https://3000-sb1.e2b.app", port: 3000 });
    const [ra, rb] = await Promise.all([a, b]);
    expect(d.startServer).toHaveBeenCalledTimes(1);
    expect(ra.url).toBe(rb.url);
  });

  it("a boot for a different sandbox never shares an in-flight result", async () => {
    let release!: (v: { url: string; port: number }) => void;
    const startServer = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockResolvedValueOnce({ url: "https://3000-sb2.e2b.app", port: 3000 });
    const d = pdeps({
      loadPreviewRow: vi.fn().mockResolvedValue({ ...LIVE_ROW, e2b_sandbox_id: "sb-gone" }),
      startServer,
    });
    const oldBox = ensureLiveEditPreview({ ...input, sandbox_id: "sb1" }, d);
    const newBox = ensureLiveEditPreview({ ...input, sandbox_id: "sb2" }, d);
    await new Promise((r) => setImmediate(r));
    release({ url: "https://3000-sb1.e2b.app", port: 3000 });
    expect((await oldBox).url).toBe("https://3000-sb1.e2b.app");
    expect((await newBox).url).toBe("https://3000-sb2.e2b.app");
    expect(startServer.mock.calls.map((c) => c[0])).toEqual(["sb1", "sb2"]);
  });

  it("an install request queued behind a failed plain boot gets its own install attempt", async () => {
    let fail!: (e: Error) => void;
    const startServer = vi
      .fn()
      .mockImplementationOnce(() => new Promise((_, rej) => (fail = rej)))
      .mockResolvedValueOnce({ url: "https://3000-sb1.e2b.app", port: 3000 });
    const d = pdeps({ exec: vi.fn().mockResolvedValue({ stdout: "000", stderr: "", exit_code: 7 }), startServer });
    const plain = ensureLiveEditPreview(input, d);
    const withInstall = ensureLiveEditPreview({ ...input, install: true }, d);
    await new Promise((r) => setImmediate(r));
    fail(new Error("no node_modules"));
    expect((await plain).reason).toBe("boot_failed");
    expect((await withInstall).reason).toBe("booted");
    expect(startServer.mock.calls).toEqual([["sb1", false], ["sb1", true]]);
  });
});

describe("readLiveEditState idle clock", () => {
  it("does not keep a preview awake when nothing is framed (no draft, no change running)", async () => {
    const d = deps({ compare: vi.fn().mockResolvedValue({ ahead_by: 0, behind_by: 0, commits: [] }) });
    await readLiveEditState(T, d, { framed: true });
    expect(d.touchPreview).not.toHaveBeenCalled();
  });

  it("does not keep a stale (behind main) draft preview awake", async () => {
    const d = deps({ compare: vi.fn().mockResolvedValue({ ahead_by: 2, behind_by: 1, commits: [] }) });
    await readLiveEditState(T, d, { framed: true });
    expect(d.touchPreview).not.toHaveBeenCalled();
  });

  it("keeps it awake while a change runs even before the first draft commit", async () => {
    const d = deps({
      compare: vi.fn().mockResolvedValue({ ahead_by: 0, behind_by: 0, commits: [] }),
      hasActiveBuild: vi.fn().mockResolvedValue(true),
    });
    await readLiveEditState(T, d, { framed: true });
    expect(d.touchPreview).toHaveBeenCalledWith("row1");
  });
});

describe("discardDraftForNewBuild", () => {
  it("is inert with the flag off", async () => {
    const d = deps({ enabled: vi.fn().mockResolvedValue(false) });
    await discardDraftForNewBuild(T, d);
    expect(d.loadTarget).not.toHaveBeenCalled();
    expect(d.deleteBranch).not.toHaveBeenCalled();
  });

  it("deletes only the draft branch of this tenant's provisioned app", async () => {
    const d = deps();
    await discardDraftForNewBuild(T, d);
    expect(d.deleteBranch).toHaveBeenCalledTimes(1);
    expect(d.deleteBranch).toHaveBeenCalledWith(expect.objectContaining({ branch: LIVE_EDIT_BRANCH, owner: "praxis-built" }));
  });

  it("never deletes on a repo that is not the tenant's provisioned app", async () => {
    const d = deps({ assertProvisioned: vi.fn().mockResolvedValue(false) });
    await discardDraftForNewBuild(T, d);
    expect(d.deleteBranch).not.toHaveBeenCalled();
  });
});

describe("shouldKeepWarm", () => {
  it("keeps a live preview and a booting live-edit preview awake at run end", () => {
    expect(shouldKeepWarm({ preview_status: "live", preview_run_id: null })).toBe(true);
    expect(shouldKeepWarm({ preview_status: "starting", preview_run_id: "live-edit:run-9" })).toBe(true);
  });

  it("still pauses other booting previews and non-previews exactly as before", () => {
    expect(shouldKeepWarm({ preview_status: "starting", preview_run_id: null })).toBe(false);
    expect(shouldKeepWarm({ preview_status: "starting", preview_run_id: "run-123" })).toBe(false);
    expect(shouldKeepWarm({ preview_status: "dead", preview_run_id: "live-edit:x" })).toBe(false);
    expect(shouldKeepWarm(null)).toBe(false);
  });
});
