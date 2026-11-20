// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), apiFetch: h.fetch }));
vi.mock("../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));

const zero = { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: null, cpc: null, cpa: null };
const payload = {
  platform: "linkedin_ads",
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-09-02", to: "2026-10-01" },
  account: { name: "Main", account_count: 1, campaign_count: 0, active_count: 0, currency: "USD" },
  totals: zero,
  prev_totals: zero,
  campaigns: [],
};

vi.mock("../agent/dashboard-ui", async (orig) => ({
  ...(await orig<typeof import("../agent/dashboard-ui")>()),
  useAgentDashboard: () => ({ data: payload, loading: false, refreshing: false, error: null, refresh: () => {}, refreshSilent: () => {} }),
}));

import { ChannelMetricsRow } from "./ChannelMetricsRow";
import { linkedin_ads } from "./platforms/linkedin_ads";

const row = () => (
  <ChannelMetricsRow slug="linkedin_ads" metrics={[]} platform={linkedin_ads} loading={false} connected hasConnectors />
);

beforeEach(() => {
  h.fetch.mockReset();
  h.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
  window.history.replaceState({ keep: 1 }, "", "/workspace?tab=channels&channel=linkedin_ads&linkedin_ads=connected&utm=x#campaigns");
});
afterEach(() => cleanup());

describe("LinkedIn Ads connected notice shows once", () => {
  it("shows the notice, then takes only the connected flag out of the URL and keeps the rest", () => {
    const replace = vi.spyOn(window.history, "replaceState");
    render(row());
    expect(screen.getByTestId("just-connected").textContent).toBe("LinkedIn Ads is connected.");
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/workspace?tab=channels&channel=linkedin_ads&utm=x#campaigns",
    );
    expect(window.history.state).toEqual({ keep: 1 });
    expect(replace).toHaveBeenCalledTimes(1);
    replace.mockRestore();
  });

  it("keeps the notice under StrictMode's double effect even though the flag is already gone", () => {
    render(<StrictMode>{row()}</StrictMode>);
    expect(screen.getByTestId("just-connected").textContent).toBe("LinkedIn Ads is connected.");
    expect(window.location.search).toBe("?tab=channels&channel=linkedin_ads&utm=x");
  });

  it("a refresh or Back to the same page after the notice does not show it again", () => {
    const first = render(row());
    expect(screen.getByTestId("just-connected")).toBeTruthy();
    first.unmount();
    render(row());
    expect(screen.queryByTestId("just-connected")).toBeNull();
  });

  it("a landing with no connected flag leaves the URL alone", () => {
    window.history.replaceState(null, "", "/workspace?tab=channels&channel=linkedin_ads#x");
    const replace = vi.spyOn(window.history, "replaceState");
    render(row());
    expect(screen.queryByTestId("just-connected")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    replace.mockRestore();
  });
});
