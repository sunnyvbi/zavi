import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/services/sandbox/lifecycle", () => ({
  getSandboxIdForRun: vi.fn(async () => "sandbox-abc"),
}));
vi.mock("../daemon-client", () => ({
  callDaemon: vi.fn(async () => ({ ok: true, result: "daemon" })),
}));

import { runBrowserOp, _resetRunEngineCache } from "../backend";
import { _resetSandboxIdCache } from "../sandbox-backend";
import {
  _resetAnchorSessionCache,
  _setBrowserActionEmitter,
} from "../anchor-backend";
import { callDaemon } from "../daemon-client";
import type { BrowserToolCtx } from "../types";

const ctx = (run_id: string): BrowserToolCtx => ({
  tenant_id: "t",
  run_id,
  agent_slug: "qa",
  repo_full_name: "x/y",
});

let prevKey: string | undefined;
beforeEach(() => {
  prevKey = process.env.ANCHOR_API_KEY;
  delete process.env.ANCHOR_API_KEY;
  _resetRunEngineCache();
  _resetSandboxIdCache();
  _resetAnchorSessionCache();
  _setBrowserActionEmitter({ emit: vi.fn(async () => "decision-fake") });
  (callDaemon as ReturnType<typeof vi.fn>).mockClear();
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.ANCHOR_API_KEY;
  else process.env.ANCHOR_API_KEY = prevKey;
  _setBrowserActionEmitter(null);
});

describe("runBrowserOp routing", () => {
  it("routes a hostile nav (instagram) to the anchor backend", async () => {
    const r = await runBrowserOp(ctx("r-ig"), {
      op: "nav",
      url: "https://instagram.com/login",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("anchor_not_configured");
    expect(callDaemon).not.toHaveBeenCalled();
  });

  it("routes an internal nav to the sandbox backend (callDaemon)", async () => {
    const r = await runBrowserOp(ctx("r-int"), {
      op: "nav",
      url: "https://latest.example.com/login",
    });
    expect(r.ok).toBe(true);
    expect(callDaemon).toHaveBeenCalledTimes(1);
  });

  it("caches the engine per run: read ops after an internal nav stay on sandbox", async () => {
    await runBrowserOp(ctx("r-cache-sb"), {
      op: "nav",
      url: "https://staging.example.com",
    });
    await runBrowserOp(ctx("r-cache-sb"), { op: "text", selector: "#go" });
    expect(callDaemon).toHaveBeenCalledTimes(2);
  });

  it("caches the engine per run: read ops after a hostile nav stay on anchor", async () => {
    await runBrowserOp(ctx("r-cache-ig"), {
      op: "nav",
      url: "https://www.linkedin.com/feed",
    });
    const r = await runBrowserOp(ctx("r-cache-ig"), {
      op: "text",
      selector: "#u",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("anchor_not_configured");
    expect(callDaemon).not.toHaveBeenCalled();
  });

  it("a pre-nav op with no engine seeds from staging_origin", async () => {
    const c: BrowserToolCtx = {
      tenant_id: "t",
      run_id: "r-prenav",
      agent_slug: "qa",
      repo_full_name: "x/y",
      staging_origin: "https://staging.example.com",
    };
    await runBrowserOp(c, { op: "text", selector: "#h" });
    expect(callDaemon).toHaveBeenCalledTimes(1);
  });

  const boCtx = (run_id: string, extra?: Partial<BrowserToolCtx>): BrowserToolCtx => ({
    tenant_id: "t",
    run_id,
    agent_slug: "browser-operator",
    repo_full_name: "x/y",
    ...extra,
  });

  it("Fix B: auto-execute slug routes a hostile nav to anchor (unchanged)", async () => {
    const r = await runBrowserOp(boCtx("r-bo-hostile"), {
      op: "nav",
      url: "https://instagram.com/login",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("anchor_not_configured");
    expect(callDaemon).not.toHaveBeenCalled();
  });

  it("Fix B: a NON-auto-execute slug still routes a normal nav to sandbox (no widening)", async () => {
    const r = await runBrowserOp(ctx("r-nonauto-internal"), {
      op: "nav",
      url: "https://latest.example.com/login",
    });
    expect(r.ok).toBe(true);
    expect(callDaemon).toHaveBeenCalledTimes(1);
  });
});
