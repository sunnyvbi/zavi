
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/sandbox/lifecycle", () => ({
  getSandboxIdForRun: vi.fn(async () => "sandbox-abc"),
}));
vi.mock("../daemon-client", () => ({
  callDaemon: vi.fn(async () => ({ ok: true, result: "daemon" })),
}));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn(async () => {}),
}));

import { runBrowserOp, _resetRunEngineCache } from "../backend";
import { _resetSandboxIdCache } from "../sandbox-backend";
import {
  _resetAnchorSessionCache,
  _setAnchorClient,
  _setBrowserSessionTracker,
  _setBrowserActionEmitter,
} from "../anchor-backend";
import { callDaemon } from "../daemon-client";
import type { BrowserToolCtx } from "../types";

describe("P1-c: runBrowserOp with read_only=true — hard-error on write, NOT auto-exec, NOT gated", () => {
  let prevKey: string | undefined;

  beforeEach(() => {
    prevKey = process.env.ANCHOR_API_KEY;
    process.env.ANCHOR_API_KEY = "test-key";
    _resetRunEngineCache();
    _resetSandboxIdCache();
    _resetAnchorSessionCache();
    _setBrowserSessionTracker({ open: vi.fn(async () => "s"), close: vi.fn(async () => {}) });
    _setBrowserActionEmitter({ emit: vi.fn(async () => "decision-fake") });
    (callDaemon as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env.ANCHOR_API_KEY;
    else process.env.ANCHOR_API_KEY = prevKey;
    _setAnchorClient(null);
    _setBrowserSessionTracker(null);
    _setBrowserActionEmitter(null);
    _resetAnchorSessionCache();
    _resetRunEngineCache();
    _resetSandboxIdCache();
  });

  const boReadOnlyCtx = (run_id: string): BrowserToolCtx => ({
    tenant_id: "t-qa",
    run_id,
    agent_slug: "browser-task",
    repo_full_name: "",
    read_only: true,
    engine: "anchor",
  });

  const boNormalCtx = (run_id: string): BrowserToolCtx => ({
    tenant_id: "t-qa",
    run_id,
    agent_slug: "browser-operator",
    repo_full_name: "",
    read_only: false,
  });

  it("read_only=true: a browser_click op returns browser_write_blocked_read_only (hard error)", async () => {
    const runAction = vi.fn(async () => ({ ok: true as const }));
    _setAnchorClient({
      createSession: vi.fn(async () => ({ id: "s" })),
      runAction,
      closeSession: vi.fn(),
    });

    const navR = await runBrowserOp(boReadOnlyCtx("r-ro-click"), {
      op: "nav",
      url: "https://staging.example.com/login",
    });
    expect(navR.ok).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(callDaemon).not.toHaveBeenCalled();

    const r = await runBrowserOp(boReadOnlyCtx("r-ro-click"), {
      op: "click",
      selector: "#submit",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error_code).toBe("browser_write_blocked_read_only");
      expect(r.error_message).toContain("read-only");
    }
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it("read_only=true: a browser_fill op returns browser_write_blocked_read_only (not approval-routed)", async () => {
    const runAction = vi.fn(async () => ({ ok: true as const }));
    const emitter = { emit: vi.fn(async () => "d") };
    _setBrowserActionEmitter(emitter);
    _setAnchorClient({
      createSession: vi.fn(async () => ({ id: "s" })),
      runAction,
      closeSession: vi.fn(),
    });

    const navR = await runBrowserOp(boReadOnlyCtx("r-ro-fill"), {
      op: "nav",
      url: "https://staging.example.com",
    });
    expect(navR.ok).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(1);

    const r = await runBrowserOp(boReadOnlyCtx("r-ro-fill"), {
      op: "fill",
      selector: "#email",
      value: "x@x.com",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("browser_write_blocked_read_only");
    expect(emitter.emit).not.toHaveBeenCalled();
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it("retired browser-operator (read_only=false): a write is NOT auto-executed any more (carveout empty)", async () => {
    const runAction = vi.fn(async () => ({ ok: true as const }));
    const emitter = { emit: vi.fn(async () => "d") };
    _setBrowserActionEmitter(emitter);
    _setAnchorClient({
      createSession: vi.fn(async () => ({ id: "s" })),
      runAction,
      closeSession: vi.fn(),
    });

    const navR = await runBrowserOp(boNormalCtx("r-normal-bo"), {
      op: "nav",
      url: "https://instagram.com/login",
    });
    expect(navR.ok).toBe(true);

    const r = await runBrowserOp(boNormalCtx("r-normal-bo"), {
      op: "fill",
      selector: "#email",
      value: "x@x.com",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("browser_action_pending_approval");
    expect(emitter.emit).toHaveBeenCalledTimes(1);
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it("read_only=true: read ops (nav, text, screenshot) still execute inline — not blocked", async () => {
    const runAction = vi.fn(async () => ({ ok: true as const }));
    _setAnchorClient({
      createSession: vi.fn(async () => ({ id: "s" })),
      runAction,
      closeSession: vi.fn(),
    });

    const navR = await runBrowserOp(boReadOnlyCtx("r-ro-reads"), {
      op: "nav",
      url: "https://staging.example.com/signup",
    });
    expect(navR.ok).toBe(true);

    const textR = await runBrowserOp(boReadOnlyCtx("r-ro-reads"), {
      op: "text",
      selector: "h1",
    });
    expect(textR.ok).toBe(true);

    const shotR = await runBrowserOp(boReadOnlyCtx("r-ro-reads"), {
      op: "screenshot",
    });
    expect(shotR.ok).toBe(true);

    expect(runAction).toHaveBeenCalledTimes(3);
    expect(callDaemon).not.toHaveBeenCalled();
  });
});
