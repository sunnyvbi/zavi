import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/services/sandbox/lifecycle", () => ({
  getSandboxIdForRun: vi.fn(async () => "sandbox-abc"),
}));
vi.mock("../daemon-client", () => ({
  callDaemon: vi.fn(async () => ({ ok: true, result: "daemon" })),
}));
vi.mock("../social-connections", () => ({
  tenantHasConnectedProfileForOrigin: vi.fn(async () => false),
}));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn(async () => {}),
}));

import { runBrowserOp, _resetRunEngineCache } from "../backend";
import { tenantHasConnectedProfileForOrigin } from "../social-connections";
import { _resetSandboxIdCache } from "../sandbox-backend";
import {
  _resetAnchorSessionCache,
  _setAnchorClient,
  _setBrowserSessionTracker,
  _setBrowserActionEmitter,
  type AnchorClient,
  type BrowserSessionTracker,
  type BrowserActionDecisionEmitter,
} from "../anchor-backend";
import { callDaemon } from "../daemon-client";
import type { BrowserToolCtx, DaemonOp } from "../types";

const HOSTILE_NAV: DaemonOp = { op: "nav", url: "https://www.linkedin.com/feed" };
const INTERNAL_NAV: DaemonOp = { op: "nav", url: "https://staging.example.com/app" };

function ctx(run_id: string): BrowserToolCtx {
  return { tenant_id: "t1", run_id, agent_slug: "qa", repo_full_name: "x/y" };
}

function boCtx(run_id: string, tenant_id = "t1"): BrowserToolCtx {
  return {
    tenant_id,
    run_id,
    agent_slug: "browser-operator",
    repo_full_name: "x/y",
  };
}

function captureEmitter(): BrowserActionDecisionEmitter & {
  calls: Array<{
    tenant_id: string;
    agent_run_id: string;
    decision_class: string;
    body: Record<string, unknown>;
  }>;
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

function okTracker(): BrowserSessionTracker {
  return { open: vi.fn(async () => "db-sess-1"), close: vi.fn(async () => {}) };
}

let prevKey: string | undefined;
let emitter: ReturnType<typeof captureEmitter>;

beforeEach(() => {
  prevKey = process.env.ANCHOR_API_KEY;
  process.env.ANCHOR_API_KEY = "test-key";
  _resetRunEngineCache();
  _resetSandboxIdCache();
  _resetAnchorSessionCache();
  _setBrowserSessionTracker(okTracker());
  emitter = captureEmitter();
  _setBrowserActionEmitter(emitter);
  (callDaemon as ReturnType<typeof vi.fn>).mockClear();
  (tenantHasConnectedProfileForOrigin as ReturnType<typeof vi.fn>).mockClear();
  (tenantHasConnectedProfileForOrigin as ReturnType<typeof vi.fn>).mockResolvedValue(
    false,
  );
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

describe("runBrowserOp WRITE gate — anchor engine (hostile origin)", () => {
  it("gates a write (fill): emits a browser.action decision, NEVER creates a session / runs the action", async () => {
    const createSession = vi.fn(async () => ({ id: "s" }));
    const runAction = vi.fn(async () => ({ ok: true as const }));
    _setAnchorClient({ createSession, runAction, closeSession: vi.fn() });

    const navR = await runBrowserOp(ctx("r-anchor"), HOSTILE_NAV);
    expect(navR.ok).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(emitter.calls).toHaveLength(0);

    const r = await runBrowserOp(ctx("r-anchor"), {
      op: "fill",
      selector: "#email",
      value: "attacker@evil.test",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("browser_action_pending_approval");
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledTimes(1);

    expect(emitter.calls).toHaveLength(1);
    expect(emitter.calls[0].decision_class).toBe("browser.action");
    expect(emitter.calls[0].tenant_id).toBe("t1");
    expect(emitter.calls[0].agent_run_id).toBe("r-anchor");
    expect(emitter.calls[0].body).toMatchObject({
      op: "fill",
      selector: "#email",
      value: "attacker@evil.test",
    });
    const ev = (emitter.calls[0].body as { decision_evidence?: Record<string, unknown> })
      .decision_evidence;
    expect(ev?.reversibility).toBe("irreversible");
    expect(ev?.blast_radius).toBe("ORANGE");
  });

  it("L8: an injected money/destructive click on a hostile origin stays gated", async () => {
    const createSession = vi.fn(async () => ({ id: "s" }));
    const runAction = vi.fn(async () => ({ ok: true as const }));
    _setAnchorClient({ createSession, runAction, closeSession: vi.fn() });

    await runBrowserOp(ctx("r-anchor-l8"), HOSTILE_NAV);
    runAction.mockClear();
    createSession.mockClear();

    const r = await runBrowserOp(ctx("r-anchor-l8"), {
      op: "click",
      selector: "button#confirm-refund-500",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("browser_action_pending_approval");
    expect(runAction).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(emitter.calls).toHaveLength(1);
    expect(emitter.calls[0].body).toMatchObject({
      op: "click",
      selector: "button#confirm-refund-500",
    });
  });

  it("fails CLOSED on the anchor path: if the emit throws, the write does NOT execute", async () => {
    const runAction = vi.fn(async () => ({ ok: true as const }));
    _setAnchorClient({
      createSession: vi.fn(async () => ({ id: "s" })),
      runAction,
      closeSession: vi.fn(),
    });
    await runBrowserOp(ctx("r-anchor-fc"), HOSTILE_NAV);
    runAction.mockClear();
    _setBrowserActionEmitter({
      emit: vi.fn(async () => {
        throw new Error("emit_decision failed: db down");
      }),
    });

    const r = await runBrowserOp(ctx("r-anchor-fc"), { op: "click", selector: "#x" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("browser_action_gate_error");
    expect(runAction).not.toHaveBeenCalled();
  });

  it("an unknown/future op on the anchor path is gated (fail-safe default-to-write)", async () => {
    const runAction = vi.fn(async () => ({ ok: true as const }));
    _setAnchorClient({
      createSession: vi.fn(async () => ({ id: "s" })),
      runAction,
      closeSession: vi.fn(),
    });
    await runBrowserOp(ctx("r-anchor-unk"), HOSTILE_NAV);
    runAction.mockClear();

    const r = await runBrowserOp(ctx("r-anchor-unk"), {
      op: "evaluate",
      selector: "document.body",
    } as unknown as DaemonOp);

    expect(r.ok).toBe(false);
    expect(runAction).not.toHaveBeenCalled();
    expect(emitter.calls).toHaveLength(1);
    expect(emitter.calls[0].body).toMatchObject({ op: "evaluate" });
  });
});

describe("runBrowserOp WRITE gate — sandbox engine (internal origin)", () => {
  it("a write (click) on the sandbox engine fails closed (no sandbox replay path) and NEVER calls callDaemon", async () => {
    const navR = await runBrowserOp(ctx("r-sandbox"), INTERNAL_NAV);
    expect(navR.ok).toBe(true);
    expect(callDaemon).toHaveBeenCalledTimes(1);

    const r = await runBrowserOp(ctx("r-sandbox"), { op: "click", selector: "#go" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("browser_write_sandbox_unsupported");
    expect(callDaemon).toHaveBeenCalledTimes(1);
    expect(emitter.calls).toHaveLength(0);
  });

  it("a fill on the sandbox engine fails closed without emitting a decision", async () => {
    await runBrowserOp(ctx("r-sandbox-2"), INTERNAL_NAV);
    (callDaemon as ReturnType<typeof vi.fn>).mockClear();

    const r = await runBrowserOp(ctx("r-sandbox-2"), {
      op: "fill",
      selector: "#email",
      value: "x",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("browser_write_sandbox_unsupported");
    expect(callDaemon).not.toHaveBeenCalled();
    expect(emitter.calls).toHaveLength(0);
  });
});

describe("runBrowserOp READ/nav passes through to the backend (both engines, no decision)", () => {
  it("sandbox: a read (text) after an internal nav reaches callDaemon, no decision emitted", async () => {
    await runBrowserOp(ctx("r-sb-read"), INTERNAL_NAV);
    const r = await runBrowserOp(ctx("r-sb-read"), { op: "text", selector: "#h1" });

    expect(r.ok).toBe(true);
    expect(callDaemon).toHaveBeenCalledTimes(2);
    expect(emitter.calls).toHaveLength(0);
  });

  it("anchor: a read (text) after a hostile nav reaches the Anchor client, no decision emitted", async () => {
    const runAction = vi.fn(async () => ({ ok: true as const, result: "page text" }));
    _setAnchorClient({
      createSession: vi.fn(async () => ({ id: "s" })),
      runAction,
      closeSession: vi.fn(),
    });

    await runBrowserOp(ctx("r-an-read"), HOSTILE_NAV);
    const r = await runBrowserOp(ctx("r-an-read"), { op: "text", selector: "#caption" });

    expect(r.ok).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(2);
    expect(callDaemon).not.toHaveBeenCalled();
    expect(emitter.calls).toHaveLength(0);
  });
});

describe("auto-execute carveout — never-auto regression guard (other slug)", () => {
  it("(a) a write from a NON-carveout slug (research) STILL emits/gates — anchor", async () => {
    const runAction = vi.fn(async () => ({ ok: true as const }));
    _setAnchorClient({
      createSession: vi.fn(async () => ({ id: "s" })),
      runAction,
      closeSession: vi.fn(),
    });
    const researchCtx: BrowserToolCtx = {
      tenant_id: "t1",
      run_id: "r-research",
      agent_slug: "research",
      repo_full_name: "x/y",
    };
    await runBrowserOp(researchCtx, HOSTILE_NAV);
    runAction.mockClear();

    const r = await runBrowserOp(researchCtx, { op: "fill", selector: "#x", value: "v" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("browser_action_pending_approval");
    expect(emitter.calls).toHaveLength(1);
    expect(runAction).not.toHaveBeenCalled();
  });

  it("(a') a write from a NON-carveout slug on sandbox STILL fails closed (no inline)", async () => {
    const researchCtx: BrowserToolCtx = {
      tenant_id: "t1",
      run_id: "r-research-sb",
      agent_slug: "research",
      repo_full_name: "x/y",
    };
    await runBrowserOp(researchCtx, INTERNAL_NAV);
    (callDaemon as ReturnType<typeof vi.fn>).mockClear();

    const r = await runBrowserOp(researchCtx, { op: "click", selector: "#go" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("browser_write_sandbox_unsupported");
    expect(callDaemon).not.toHaveBeenCalled();
    expect(emitter.calls).toHaveLength(0);
  });
});

describe("auto-execute carveout — browser-operator executes INLINE", () => {

  it("(b') Gap3/D2 — a write op NOT in AUTO_EXECUTE_OPS GATES even for browser-operator (never inline)", async () => {
    const runAction = vi.fn(async () => ({ ok: true as const }));
    _setAnchorClient({
      createSession: vi.fn(async () => ({ id: "s" })),
      runAction,
      closeSession: vi.fn(),
    });
    await runBrowserOp(boCtx("r-bo-newop"), HOSTILE_NAV);
    runAction.mockClear();

    const r = await runBrowserOp(boCtx("r-bo-newop"), {
      op: "evaluate",
      selector: "#x",
    } as unknown as DaemonOp);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("browser_action_pending_approval");
    expect(runAction).not.toHaveBeenCalled();
    expect(emitter.calls).toHaveLength(1);
    expect(emitter.calls[0].decision_class).toBe("browser.action");
    expect(emitter.calls[0].body).toMatchObject({ op: "evaluate" });
  });

});

