// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn(async () => new Response(null, { status: 204 })));
vi.mock("@/lib/api", () => ({ apiFetch }));

import { reportWorkspaceOpened, resetWorkspaceOpened, useWorkspaceOpenedSignal, WORKSPACE_OPENED_MIN_GAP_MS } from "./workspaceOpened";

const flush = () => new Promise((r) => setTimeout(r, 0));
let hidden = false;

beforeEach(() => {
  resetWorkspaceOpened();
  apiFetch.mockClear();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});
afterEach(() => cleanup());

describe("useWorkspaceOpenedSignal", () => {
  it("reports on load, and again on focus once the gap has passed; never on a timer", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval"] });
    vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
    renderHook(() => useWorkspaceOpenedSignal());
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith("/api/workspace/opened", { method: "POST" });
    window.dispatchEvent(new Event("focus"));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(WORKSPACE_OPENED_MIN_GAP_MS * 6);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    expect(apiFetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("a hidden tab reports nothing until it comes back into view", () => {
    hidden = true;
    renderHook(() => useWorkspaceOpenedSignal());
    document.dispatchEvent(new Event("visibilitychange"));
    expect(apiFetch).not.toHaveBeenCalled();
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});

describe("reportWorkspaceOpened", () => {
  it("reports once per gap", () => {
    reportWorkspaceOpened(1_000);
    reportWorkspaceOpened(2_000);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    reportWorkspaceOpened(1_000 + WORKSPACE_OPENED_MIN_GAP_MS);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("a report that failed is retried on the next open", async () => {
    apiFetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    reportWorkspaceOpened(1_000);
    await flush();
    reportWorkspaceOpened(2_000);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
