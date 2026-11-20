// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn(async (_url: string) => ({ ok: true, json: async () => ({}) })),
}));
vi.mock("@/lib/api", () => ({ apiFetch }));

vi.mock("@/lib/workspace/useRealtimeChannel", () => ({
  useRealtimeChannel: () => {},
}));

import { useAgentDashboard } from "./dashboard-ui";
import { DashboardOpenSourceProvider } from "@/lib/workspace/dashboardOpenSource";

function Panel() {
  const state = useAgentDashboard<unknown>("engineer");
  return <div data-testid="panel">{state.loading ? "…" : "ok"}</div>;
}

const urls = () => apiFetch.mock.calls.map((c) => c[0]);

beforeEach(() => {
  apiFetch.mockClear();
});
afterEach(() => cleanup());

describe("dashboard open source", () => {
  it("a roster mount fetches the plain dashboard URL", async () => {
    render(<Panel />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(urls()[0]).toBe("/api/agents/engineer/dashboard");
  });

  it("a mount inside a summoned surface declares source=summon", async () => {
    render(
      <DashboardOpenSourceProvider source="summon">
        <Panel />
      </DashboardOpenSourceProvider>,
    );
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(urls()[0]).toBe("/api/agents/engineer/dashboard?source=summon");
  });

  it("a refresh never carries a source, even from a summoned mount", async () => {
    function RefreshingPanel() {
      const state = useAgentDashboard<unknown>("engineer");
      return (
        <button type="button" onClick={state.refresh}>
          refresh
        </button>
      );
    }
    const { getByRole } = render(
      <DashboardOpenSourceProvider source="summon">
        <RefreshingPanel />
      </DashboardOpenSourceProvider>,
    );
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    getByRole("button").click();
    await waitFor(() => expect(apiFetch.mock.calls.length).toBeGreaterThan(1));
    const refreshUrl = urls()[1];
    expect(refreshUrl).not.toContain("source=");
    expect(refreshUrl).toBe("/api/agents/engineer/dashboard?refresh=1&meter=1");
  });
});
