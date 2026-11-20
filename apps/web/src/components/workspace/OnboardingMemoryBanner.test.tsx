// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("./WorkspaceShell", () => ({ useWorkspace: () => ({ openTab: vi.fn() }) }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => null }));
vi.mock("@/app/connectors/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/app/connectors/OperatorDbConnectButton", () => ({ OperatorDbForm: () => null }));
vi.mock("@/lib/workspace/useBuildProduct", () => ({
  useBuildProduct: () => ({ buildAppIntent: "existing", loaded: true }),
}));

import { BrainSetupCard, ONBOARDING_MEMORY_POLL_MS } from "./GettingStartedCard";

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const FULL_BRAIN = { filled: 10, total: 10, slots: [] };
let memoryStatus: string | null = null;
let retryStatus = 202;

beforeEach(() => {
  memoryStatus = null;
  retryStatus = 202;
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/api/workspace/activation") return json({ brain: FULL_BRAIN, memory_status: memoryStatus });
    if (path === "/api/workspace/onboarding-memory/retry") return json({}, retryStatus);
    return json({}, 404);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const activationCalls = () => apiFetch.mock.calls.filter((c) => c[0] === "/api/workspace/activation").length - 1;

describe("BrainSetupCard: background website memory", () => {
  it("says Zavi is reading the site and polls every 5s until it is done", async () => {
    vi.useFakeTimers();
    memoryStatus = "pending";
    render(<BrainSetupCard />);
    await act(async () => {});
    expect(screen.getByText("Zavi is reading your site…")).toBeTruthy();
    expect(activationCalls()).toBe(1);
    memoryStatus = "ready";
    await act(async () => { await vi.advanceTimersByTimeAsync(ONBOARDING_MEMORY_POLL_MS); });
    expect(activationCalls()).toBe(2);
    expect(screen.queryByText("Zavi is reading your site…")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(ONBOARDING_MEMORY_POLL_MS * 3); });
    expect(activationCalls()).toBe(2);
  });

  it("a failed first read is retried, so a blip does not hide the Retry banner", async () => {
    vi.useFakeTimers();
    memoryStatus = "failed";
    let bannerReads = 0;
    apiFetch.mockImplementation(async (path: string) => {
      if (path === "/api/workspace/activation") {
        bannerReads += 1;
        if (bannerReads <= 2) throw new TypeError("network");
        return json({ brain: FULL_BRAIN, memory_status: memoryStatus });
      }
      return json({}, 404);
    });
    render(<BrainSetupCard />);
    await act(async () => {});
    expect(screen.queryByText("Zavi couldn't finish reading your site")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(ONBOARDING_MEMORY_POLL_MS); });
    expect(screen.getByText("Zavi couldn't finish reading your site")).toBeTruthy();
  });

  it("shows the failure with Retry, which calls the retry endpoint and resumes polling", async () => {
    memoryStatus = "failed";
    render(<BrainSetupCard />);
    await screen.findByText("Zavi couldn't finish reading your site");
    memoryStatus = "pending";
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Zavi is reading your site…");
    expect(apiFetch).toHaveBeenCalledWith("/api/workspace/onboarding-memory/retry", { method: "POST" });
    await waitFor(() => expect(activationCalls()).toBe(2));
  });

  it("keeps Retry on screen with a message when the retry is refused", async () => {
    memoryStatus = "failed";
    retryStatus = 429;
    render(<BrainSetupCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByText("Too many tries. Wait a minute, then try again.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("shows nothing for a workspace with no background memory job", async () => {
    render(<BrainSetupCard />);
    await waitFor(() => expect(activationCalls()).toBeGreaterThan(0));
    expect(screen.queryByText(/reading your site/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
