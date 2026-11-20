import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/sandbox/lifecycle", () => ({ getSandboxIdForRun: vi.fn(async () => null) }));
vi.mock("../daemon-client", () => ({ callDaemon: vi.fn(async () => ({ ok: true, result: "daemon" })) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import { runBrowserOp, _resetRunEngineCache } from "../backend";
import {
  _resetAnchorSessionCache,
  _setAnchorClient,
  _setBrowserSessionTracker,
  _setBrowserActionEmitter,
  closeAnchorRun,
} from "../anchor-backend";
import { callDaemon } from "../daemon-client";
import type { BrowserToolCtx } from "../types";

const pinned = (key: string, over: Partial<BrowserToolCtx> = {}): BrowserToolCtx => ({
  tenant_id: "t1",
  run_id: "11111111-1111-1111-1111-111111111111",
  agent_slug: "browser-task",
  repo_full_name: "",
  engine: "anchor",
  read_only: true,
  session_key: key,
  logged_out: true,
  network_guard: true,
  ...over,
});

let prevKey: string | undefined;
const createSession = vi.fn(async (_o: Record<string, unknown>): Promise<{ id: string }> => ({
  id: `s-${(createSession.mock.calls as unknown[]).length}`,
}));
const runAction = vi.fn(async () => ({ ok: true as const }));
const emit = vi.fn(async () => "d");
const trackerOpen = vi.fn(async () => "row");
const trackerClose = vi.fn(async () => {});

beforeEach(() => {
  prevKey = process.env.ANCHOR_API_KEY;
  process.env.ANCHOR_API_KEY = "k";
  _resetRunEngineCache();
  _resetAnchorSessionCache();
  createSession.mockClear();
  runAction.mockClear();
  emit.mockClear();
  trackerOpen.mockClear();
  trackerClose.mockClear();
  (callDaemon as ReturnType<typeof vi.fn>).mockClear();
  _setAnchorClient({ createSession, runAction, closeSession: vi.fn(async () => {}) });
  _setBrowserSessionTracker({ open: trackerOpen, close: trackerClose });
  _setBrowserActionEmitter({ emit });
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.ANCHOR_API_KEY;
  else process.env.ANCHOR_API_KEY = prevKey;
  _setAnchorClient(null);
  _setBrowserSessionTracker(null);
  _setBrowserActionEmitter(null);
});

describe("engine-pinned read-only browser sessions", () => {
  it("routes a NORMAL-origin nav for a non-browser-operator slug to Anchor (never the sandbox)", async () => {
    const r = await runBrowserOp(pinned("k1"), { op: "nav", url: "https://example.com/" });
    expect(r.ok).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(callDaemon).not.toHaveBeenCalled();
  });

  it.each([
    { op: "click", selector: "#buy" },
    { op: "fill", selector: "#q", value: "x" },
    { op: "evaluate", selector: "#x" },
  ])("refuses write op %o: no decision, no backend call", async (op) => {
    const r = await runBrowserOp(pinned("k2"), op as never);
    expect(r).toMatchObject({ ok: false, error_code: "browser_write_blocked_read_only" });
    expect(runAction).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("refuses an engine pin without read_only", async () => {
    const r = await runBrowserOp(pinned("k3", { read_only: false }), { op: "nav", url: "https://example.com/" });
    expect(r).toMatchObject({ ok: false, error_code: "browser_engine_pin_requires_read_only" });
    expect(runAction).not.toHaveBeenCalled();
  });

  it("current_url and page_outline are reads (not gated)", async () => {
    expect((await runBrowserOp(pinned("k4"), { op: "current_url" })).ok).toBe(true);
    expect((await runBrowserOp(pinned("k4"), { op: "page_outline" })).ok).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it("each session_key gets its own fresh, logged-out, guarded Anchor session; close meters time", async () => {
    await runBrowserOp(pinned("call-A"), { op: "nav", url: "https://example.com/" });
    await runBrowserOp(pinned("call-A"), { op: "current_url" });
    await runBrowserOp(pinned("call-B"), { op: "nav", url: "https://example.com/" });
    expect(createSession).toHaveBeenCalledTimes(2);
    for (const [opts] of createSession.mock.calls) {
      expect(opts.profileId).toBeUndefined();
      expect(opts.networkGuard).toBe(true);
    }
    expect(trackerOpen).toHaveBeenCalledWith(expect.objectContaining({ run_id: "11111111-1111-1111-1111-111111111111" }));
    const closed = await closeAnchorRun("call-A", "browser_task_end");
    expect(closed.opened).toBe(true);
    expect(trackerClose).toHaveBeenCalledWith(expect.objectContaining({ browser_seconds: expect.any(Number) }));
  });

  it("a budget/concurrency refusal surfaces as anchor_budget_exceeded (the worker maps it to busy)", async () => {
    trackerOpen.mockRejectedValueOnce(new Error("browser_session_concurrency_exceeded"));
    const r = await runBrowserOp(pinned("k5"), { op: "nav", url: "https://example.com/" });
    expect(r).toMatchObject({ ok: false, error_code: "anchor_budget_exceeded" });
    expect(createSession).not.toHaveBeenCalled();
  });
});
