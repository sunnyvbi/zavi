import { describe, it, expect, beforeEach, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc }),
}));

import { openBrowserSession, closeBrowserSession } from "../browser-sessions";

beforeEach(() => rpc.mockReset());

describe("openBrowserSession", () => {
  it("calls open_browser_session with mapped params + returns the id", async () => {
    rpc.mockResolvedValueOnce({ data: "sess-row-1", error: null });
    const id = await openBrowserSession({
      tenant_id: "t1",
      run_id: "r1",
      engine: "anchor",
      origin: "https://instagram.com",
    });
    expect(id).toBe("sess-row-1");
    expect(rpc).toHaveBeenCalledWith("open_browser_session", {
      p_tenant_id: "t1",
      p_run_id: "r1",
      p_engine: "anchor",
      p_origin: "https://instagram.com",
      p_anchor_profile_id: null,
    });
  });

  it("throws (never opens) when the budget/cap RPC raises", async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "browser_session_budget_exceeded: ..." },
    });
    await expect(
      openBrowserSession({ tenant_id: "t1", run_id: "r1", engine: "anchor" }),
    ).rejects.toThrow(/browser_session_budget_exceeded/);
  });
});

describe("closeBrowserSession", () => {
  it("records usage on close", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await closeBrowserSession({
      session_id: "sess-row-1",
      browser_seconds: 42,
      proxy_bytes: 1000,
      reason: "run_end",
    });
    expect(rpc).toHaveBeenCalledWith("close_browser_session", {
      p_session_id: "sess-row-1",
      p_browser_seconds: 42,
      p_proxy_bytes: 1000,
      p_reason: "run_end",
    });
  });

  it("defaults usage counters to 0 when omitted", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await closeBrowserSession({ session_id: "s" });
    expect(rpc).toHaveBeenCalledWith("close_browser_session", {
      p_session_id: "s",
      p_browser_seconds: 0,
      p_proxy_bytes: 0,
      p_reason: null,
    });
  });
});
