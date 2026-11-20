import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  anchorBackend,
  closeAnchorRun,
  executeApprovedBrowserAction,
  _setAnchorClient,
  _resetAnchorSessionCache,
  _setBrowserSessionTracker,
  _setBrowserActionEmitter,
  type AnchorClient,
  type AnchorSession,
  type BrowserSessionTracker,
  type BrowserActionDecisionEmitter,
} from "../anchor-backend";
import type { BrowserToolCtx, DaemonOp } from "../types";

const CTX: BrowserToolCtx = {
  tenant_id: "t1",
  run_id: "run-anchor-1",
  agent_slug: "qa",
  repo_full_name: "x/y",
};

const NAV: DaemonOp = { op: "nav", url: "https://instagram.com/login" };

function okTracker(): BrowserSessionTracker {
  return {
    open: vi.fn(async () => "db-sess-1"),
    close: vi.fn(async () => {}),
  };
}

function captureEmitter(): BrowserActionDecisionEmitter & {
  calls: Array<{ tenant_id: string; agent_run_id: string; decision_class: string; body: Record<string, unknown> }>;
} {
  const calls: Array<{
    tenant_id: string;
    agent_run_id: string;
    decision_class: string;
    body: Record<string, unknown>;
  }> = [];
  return {
    calls,
    emit: vi.fn(async (a) => {
      calls.push(a);
      return "decision-fake-1";
    }),
  };
}

let prevKey: string | undefined;
beforeEach(() => {
  prevKey = process.env.ANCHOR_API_KEY;
  _resetAnchorSessionCache();
  _setAnchorClient(null);
  _setBrowserSessionTracker(okTracker());
  _setBrowserActionEmitter(captureEmitter());
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.ANCHOR_API_KEY;
  else process.env.ANCHOR_API_KEY = prevKey;
  _setAnchorClient(null);
  _setBrowserSessionTracker(null);
  _setBrowserActionEmitter(null);
  _resetAnchorSessionCache();
});

describe("anchorBackend key-gate (safety rail)", () => {
  it("returns anchor_not_configured + makes NO client call when ANCHOR_API_KEY is unset", async () => {
    delete process.env.ANCHOR_API_KEY;
    const createSession = vi.fn();
    _setAnchorClient({
      createSession,
      runAction: vi.fn(),
      closeSession: vi.fn(),
    } as unknown as AnchorClient);

    const r = await anchorBackend.runOp(CTX, NAV);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("anchor_not_configured");
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("anchorBackend session reuse (with key + mock client)", () => {
  it("creates a session once per run and reuses it across ops", async () => {
    process.env.ANCHOR_API_KEY = "test-key";
    const session: AnchorSession = { id: "sess-1", cdp_url: "wss://x" };
    const createSession = vi.fn(async () => session);
    const runAction = vi.fn(async () => ({ ok: true as const }));
    _setAnchorClient({
      createSession,
      runAction,
      closeSession: vi.fn(),
    });

    const r1 = await anchorBackend.runOp(CTX, NAV);
    const r2 = await anchorBackend.runOp(CTX, {
      op: "text",
      selector: "#post",
    });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(runAction).toHaveBeenCalledTimes(2);
    expect(runAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ session, op: { op: "text", selector: "#post" } }),
    );
  });

  it("passes the op through to the client unchanged", async () => {
    process.env.ANCHOR_API_KEY = "test-key";
    const runAction = vi.fn(async () => ({
      ok: false as const,
      error_code: "x",
      error_message: "y",
    }));
    _setAnchorClient({
      createSession: vi.fn(async () => ({ id: "s" })),
      runAction,
      closeSession: vi.fn(),
    });
    await anchorBackend.runOp(CTX, NAV);
    expect(runAction).toHaveBeenCalledWith(
      expect.objectContaining({ op: NAV, apiKey: "test-key" }),
    );
  });

  it("reserves a session row (tracker.open) before creating the Anchor session", async () => {
    process.env.ANCHOR_API_KEY = "test-key";
    const open = vi.fn(async () => "db-sess-9");
    _setBrowserSessionTracker({ open, close: vi.fn(async () => {}) });
    const createSession = vi.fn(async () => ({ id: "s" }));
    _setAnchorClient({
      createSession,
      runAction: vi.fn(async () => ({ ok: true as const })),
      closeSession: vi.fn(),
    });

    await anchorBackend.runOp(CTX, NAV);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "t1",
        run_id: "run-anchor-1",
        origin: "https://instagram.com/login",
      }),
    );
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(
      createSession.mock.invocationCallOrder[0],
    );
  });

  it("returns anchor_budget_exceeded + does NOT create a session when the cap/budget is hit", async () => {
    process.env.ANCHOR_API_KEY = "test-key";
    _setBrowserSessionTracker({
      open: vi.fn(async () => {
        throw new Error(
          "open_browser_session failed: browser_session_budget_exceeded",
        );
      }),
      close: vi.fn(async () => {}),
    });
    const createSession = vi.fn(async () => ({ id: "s" }));
    _setAnchorClient({
      createSession,
      runAction: vi.fn(async () => ({ ok: true as const })),
      closeSession: vi.fn(),
    });

    const r = await anchorBackend.runOp(CTX, NAV);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("anchor_budget_exceeded");
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("closeAnchorRun (dispatcher run-end hook)", () => {
  it("closes the Anchor session + de-meters the budget row, then clears caches", async () => {
    process.env.ANCHOR_API_KEY = "test-key";
    const session: AnchorSession = { id: "sess-z", cdp_url: "wss://z" };
    const closeSession = vi.fn(async () => {});
    const createSession = vi.fn(async () => session);
    _setAnchorClient({
      createSession,
      runAction: vi.fn(async () => ({ ok: true as const })),
      closeSession,
    });
    const trackerClose = vi.fn(async () => {});
    _setBrowserSessionTracker({
      open: vi.fn(async () => "db-row-z"),
      close: trackerClose,
    });

    await anchorBackend.runOp(CTX, NAV);
    await closeAnchorRun(CTX.run_id, "run_end");

    expect(closeSession).toHaveBeenCalledWith(
      expect.objectContaining({ session }),
    );
    expect(trackerClose).toHaveBeenCalledWith({
      session_id: "db-row-z",
      reason: "run_end",
      browser_seconds: expect.any(Number),
    });

    await anchorBackend.runOp(CTX, NAV);
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it("a FAILED remote close leaves the row open (reapable), keeps the handle, still returns metered time", async () => {
    process.env.ANCHOR_API_KEY = "test-key";
    const session: AnchorSession = { id: "sess-f", cdp_url: "wss://f" };
    const closeSession = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error("timeout"));
    _setAnchorClient({
      createSession: vi.fn(async () => session),
      runAction: vi.fn(async () => ({ ok: true as const })),
      closeSession,
    });
    const trackerClose = vi.fn(async () => {});
    _setBrowserSessionTracker({ open: vi.fn(async () => "db-row-f"), close: trackerClose });

    await anchorBackend.runOp(CTX, NAV);
    const first = await closeAnchorRun(CTX.run_id, "run_end");
    expect(first.opened).toBe(true);
    expect(first.browser_seconds).toBeGreaterThan(0);
    expect(trackerClose).not.toHaveBeenCalled();

    await closeAnchorRun(CTX.run_id, "run_end");
    expect(closeSession).toHaveBeenCalledTimes(2);
    expect(trackerClose).toHaveBeenCalledWith(expect.objectContaining({ session_id: "db-row-f" }));
  });

  it("is a safe no-op for a run that never opened an Anchor session", async () => {
    process.env.ANCHOR_API_KEY = "test-key";
    const closeSession = vi.fn(async () => {});
    _setAnchorClient({
      createSession: vi.fn(async () => ({ id: "s" })),
      runAction: vi.fn(),
      closeSession,
    });
    const trackerClose = vi.fn(async () => {});
    _setBrowserSessionTracker({ open: vi.fn(async () => "x"), close: trackerClose });

    await expect(
      closeAnchorRun("run-never-opened", "run_end"),
    ).resolves.toEqual({ browser_seconds: 0, opened: false });
    expect(closeSession).not.toHaveBeenCalled();
    expect(trackerClose).not.toHaveBeenCalled();
  });

  it("closes the session exactly once when the run throws then hits the run-end finally", async () => {
    process.env.ANCHOR_API_KEY = "test-key";
    const session: AnchorSession = { id: "sess-throw", cdp_url: "wss://t" };
    const closeSession = vi.fn(async () => {});
    _setAnchorClient({
      createSession: vi.fn(async () => session),
      runAction: vi.fn(async () => {
        throw new Error("simulated mid-run dispatch failure");
      }),
      closeSession,
    });
    const trackerClose = vi.fn(async () => {});
    _setBrowserSessionTracker({
      open: vi.fn(async () => "db-row-throw"),
      close: trackerClose,
    });

    let caught: Error | null = null;
    try {
      await anchorBackend.runOp(CTX, NAV);
    } catch (e) {
      caught = e as Error;
    } finally {
      await closeAnchorRun(CTX.run_id, "run_end");
    }

    expect(caught?.message).toBe("simulated mid-run dispatch failure");
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith(
      expect.objectContaining({ session }),
    );
    expect(trackerClose).toHaveBeenCalledTimes(1);
    expect(trackerClose).toHaveBeenCalledWith({
      session_id: "db-row-throw",
      reason: "run_end",
      browser_seconds: expect.any(Number),
    });

    await closeAnchorRun(CTX.run_id, "run_end");
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(trackerClose).toHaveBeenCalledTimes(1);
  });
});

describe("anchorBackend no longer gates (G-1a — gate lifted to runBrowserOp)", () => {
  it("does NOT emit a decision and DOES execute a write op that reaches it directly", async () => {
    process.env.ANCHOR_API_KEY = "test-key";
    const runAction = vi.fn(async () => ({ ok: true as const }));
    const createSession = vi.fn(async () => ({ id: "s" }));
    _setAnchorClient({ createSession, runAction, closeSession: vi.fn() });
    const emitter = captureEmitter();
    _setBrowserActionEmitter(emitter);

    const r = await anchorBackend.runOp(CTX, {
      op: "fill",
      selector: "#email",
      value: "x",
    });

    expect(r.ok).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(emitter.calls).toHaveLength(0);
  });

  it("a read op (text) executes inline via runAction (no decision emitted)", async () => {
    process.env.ANCHOR_API_KEY = "test-key";
    const runAction = vi.fn(async () => ({ ok: true as const, result: "page text" }));
    _setAnchorClient({
      createSession: vi.fn(async () => ({ id: "s" })),
      runAction,
      closeSession: vi.fn(),
    });
    const emitter = captureEmitter();
    _setBrowserActionEmitter(emitter);

    const r = await anchorBackend.runOp(CTX, { op: "text", selector: "#caption" });

    expect(r.ok).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(emitter.calls).toHaveLength(0);
  });
});

describe("executeApprovedBrowserAction (B-2 post-approval replay)", () => {
  const REAL_RUN_UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

  it("executes the approved op directly (bypasses the gate) and tears down the session", async () => {
    process.env.ANCHOR_API_KEY = "test-key";
    const session: AnchorSession = { id: "replay-sess", cdp_url: "wss://r" };
    const createSession = vi.fn(async () => session);
    const runAction = vi.fn(async () => ({ ok: true as const }));
    const closeSession = vi.fn(async () => {});
    _setAnchorClient({ createSession, runAction, closeSession });
    const trackerOpen = vi.fn(async () => "replay-db-row");
    const trackerClose = vi.fn(async () => {});
    _setBrowserSessionTracker({ open: trackerOpen, close: trackerClose });

    const r = await executeApprovedBrowserAction({
      tenant_id: "t1",
      replay_run_id: REAL_RUN_UUID,
      op: { op: "click", selector: "#approved-btn" },
    });

    expect(r.ok).toBe(true);
    expect(trackerOpen).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: "t1", run_id: REAL_RUN_UUID }),
    );
    expect(runAction).toHaveBeenCalledWith(
      expect.objectContaining({ op: { op: "click", selector: "#approved-btn" } }),
    );
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(trackerClose).toHaveBeenCalledWith({
      session_id: "replay-db-row",
      reason: "browser_action_replay",
    });
  });

  it("tolerates a null replay_run_id (out-of-band decision had no agent_run_id)", async () => {
    process.env.ANCHOR_API_KEY = "test-key";
    const runAction = vi.fn(async () => ({ ok: true as const }));
    _setAnchorClient({
      createSession: vi.fn(async () => ({ id: "s" })),
      runAction,
      closeSession: vi.fn(async () => {}),
    });
    const trackerOpen = vi.fn(async () => "replay-db-row-null");
    _setBrowserSessionTracker({ open: trackerOpen, close: vi.fn(async () => {}) });

    const r = await executeApprovedBrowserAction({
      tenant_id: "t1",
      replay_run_id: null,
      op: { op: "click", selector: "#approved-btn" },
    });

    expect(r.ok).toBe(true);
    expect(trackerOpen).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: "t1", run_id: null }),
    );
  });

  it("is a clean no-op when ANCHOR_API_KEY is unset", async () => {
    delete process.env.ANCHOR_API_KEY;
    const createSession = vi.fn();
    _setAnchorClient({
      createSession,
      runAction: vi.fn(),
      closeSession: vi.fn(),
    } as unknown as AnchorClient);

    const r = await executeApprovedBrowserAction({
      tenant_id: "t1",
      replay_run_id: "x",
      op: { op: "click", selector: "#x" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("anchor_not_configured");
    expect(createSession).not.toHaveBeenCalled();
  });
});
