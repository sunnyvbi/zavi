// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";

const api = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => api(...args) }));
vi.mock("@/components/auth/AuthMarketingPanel", () => ({
  AuthMarketingPanel: () => <aside>Marketing</aside>,
}));
vi.mock("@/components/marketing/ZaviWordmark", () => ({ ZaviWordmark: () => null }));
vi.mock("@/components/ZaviMascot", () => ({ ZaviMascot: () => null }));
vi.mock("@/fonts", () => ({ inter: { variable: "inter" } }));

import { SCAN_POLL_MAX_MS, SCAN_POLL_MS, startWebsiteScan, useWebsiteScanStatus, websiteScanFromNext, websiteScanLine } from "./websiteScan";
import { AuthShell } from "@/components/auth/AuthShell";
import { WebsiteLearningPanel } from "./WebsiteLearningPanel";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const scanPolls = () => api.mock.calls.filter((c) => String(c[0]).startsWith("/api/onboarding/scan/")).length;

beforeEach(() => {
  api.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("websiteScanFromNext", () => {
  it("reads the website and scan id a login next carries", () => {
    expect(websiteScanFromNext("/onboarding/past-work?website=example.com&scan=abc&resume=website")).toEqual({ host: "example.com", scanId: "abc" });
  });
  it("is null without both", () => {
    expect(websiteScanFromNext("/onboarding/past-work?website=example.com")).toBeNull();
    expect(websiteScanFromNext("/workspace?scan=abc")).toBeNull();
    expect(websiteScanFromNext(null)).toBeNull();
  });
});

describe("websiteScanLine", () => {
  it("reads while running, says done when done, and says nothing on failure", () => {
    expect(websiteScanLine("example.com", "queued")).toBe("Reading example.com…");
    expect(websiteScanLine("example.com", "running")).toBe("Reading example.com…");
    expect(websiteScanLine("example.com", "done")).toBe("Done reading example.com");
    expect(websiteScanLine("example.com", "failed")).toBeNull();
    expect(websiteScanLine("example.com", null)).toBeNull();
  });
});

describe("startWebsiteScan", () => {
  it("posts the website and returns the scan id", async () => {
    api.mockResolvedValue(json({ scan_id: "s1" }));
    await expect(startWebsiteScan("example.com")).resolves.toBe("s1");
    expect(api.mock.calls[0][0]).toBe("/api/onboarding/scan");
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ website: "example.com" });
  });
  it("returns null instead of throwing on a refusal or a network error", async () => {
    api.mockResolvedValue(json({ scan_id: null, reason: "rate_limited" }));
    await expect(startWebsiteScan("example.com")).resolves.toBeNull();
    api.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(startWebsiteScan("example.com")).resolves.toBeNull();
  });
});

describe("useWebsiteScanStatus", () => {
  it("polls every 3s and stops once the scan is done", async () => {
    vi.useFakeTimers();
    let status = "running";
    api.mockImplementation(async () => json({ status, host: "example.com" }));
    const { result } = renderHook(() => useWebsiteScanStatus("s1"));
    await act(async () => {});
    expect(result.current).toBe("running");
    expect(scanPolls()).toBe(1);
    status = "done";
    await act(async () => { await vi.advanceTimersByTimeAsync(SCAN_POLL_MS); });
    expect(result.current).toBe("done");
    await act(async () => { await vi.advanceTimersByTimeAsync(SCAN_POLL_MS * 5); });
    expect(scanPolls()).toBe(2);
  });
  it("gives up after 3 minutes", async () => {
    vi.useFakeTimers();
    api.mockImplementation(async () => json({ status: "running", host: "example.com" }));
    renderHook(() => useWebsiteScanStatus("s1"));
    await act(async () => { await vi.advanceTimersByTimeAsync(SCAN_POLL_MAX_MS + SCAN_POLL_MS * 5); });
    expect(scanPolls()).toBeLessThanOrEqual(SCAN_POLL_MAX_MS / SCAN_POLL_MS + 1);
    const settled = scanPolls();
    await act(async () => { await vi.advanceTimersByTimeAsync(SCAN_POLL_MS * 10); });
    expect(scanPolls()).toBe(settled);
  });
  it("never polls without a scan id", async () => {
    const { result } = renderHook(() => useWebsiteScanStatus(null));
    await act(async () => {});
    expect(result.current).toBeNull();
    expect(api).not.toHaveBeenCalled();
  });
});

describe("AuthShell aside slot", () => {
  it("shows the website learning panel with its live line instead of the marketing panel", () => {
    render(
      <AuthShell aside={<WebsiteLearningPanel status="Reading example.com…" />}>
        <h1>Create your workspace.</h1>
      </AuthShell>,
    );
    expect(screen.queryByText("Marketing")).toBeNull();
    expect(screen.getByText("One link. Zavi learns:")).toBeTruthy();
    expect(screen.getByText("Reading example.com…")).toBeTruthy();
  });
  it("keeps the marketing panel when no aside is given", () => {
    render(<AuthShell><h1>Open your workspace.</h1></AuthShell>);
    expect(screen.getByText("Marketing")).toBeTruthy();
  });
});
