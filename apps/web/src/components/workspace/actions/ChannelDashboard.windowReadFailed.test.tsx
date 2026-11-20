import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), apiFetch: h.fetch }));
vi.mock("../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("@/lib/responsive", () => ({ useIsCompact: () => false, useMediaMatch: () => false }));

import { ChannelMetricsRow } from "./ChannelMetricsRow";
import { linkedin_ads } from "./platforms/linkedin_ads";
import { reddit_ads } from "./platforms/reddit_ads";
import { __resetAgentDashCache } from "../agent/dashboard-ui";

const zero = { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: null, cpc: null, cpa: null };
const payload = (platform: string, days: number, spend: number, name: string) => ({
  platform,
  connected: true,
  error_code: null,
  window_days: days,
  period: { from: "2026-10-01", to: "2026-10-30" },
  account: { name: "Main", account_count: 1, campaign_count: 1, active_count: 1, currency: "USD" },
  totals: { ...zero, spend, clicks: 40, conversions: 4, cpa: spend / 4 },
  prev_totals: zero,
  campaigns: [{ id: "501", currency: "USD", name, status: "ACTIVE", ad_delivery: "serving", ads_not_running: 0, spend, clicks: 40, conversions: 4, cpa: spend / 4, url: null }],
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  __resetAgentDashCache();
  h.fetch.mockReset();
});
afterEach(() => cleanup());

const PLATFORMS = [
  ["linkedin_ads", linkedin_ads],
  ["reddit_ads", reddit_ads],
] as const;

describe.each(PLATFORMS)("%s: a new window whose read fails never shows the old window's numbers under its label", (slug, platform) => {
  it("clears the old Spend, CPA and campaign rows, says why, and fills in once a Refresh lands", async () => {
    let refreshNow: ((r: Response) => void) | null = null;
    h.fetch.mockImplementation((path: string) => {
      if (path.includes("days=30")) return Promise.resolve(json(200, payload(slug, 30, 1234.56, "Thirty day run")));
      if (path.includes("refresh=1")) return new Promise<Response>((resolve) => (refreshNow = resolve));
      return Promise.resolve(json(400, { error: { code: "bad_request" } }));
    });
    render(<ChannelMetricsRow slug={slug} metrics={[]} platform={platform} loading={false} connected hasConnectors />);
    await screen.findByText("Thirty day run");
    expect(document.body.textContent).toMatch(/\$1,23[45]/);

    fireEvent.click(screen.getByRole("button", { name: /Last 30 days/ }));
    fireEvent.click(screen.getByRole("option", { name: "Last 7 days" }));

    await waitFor(() => expect(h.fetch.mock.calls.some(([path]) => String(path).includes("days=7"))).toBe(true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole("button", { name: /Last 7 days/ })).toBeTruthy();
    expect(screen.queryByText("Thirty day run")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\$1,23[45]/);
    expect(document.body.textContent).not.toContain("$308.64");
    expect(screen.getByTestId("window-read-failed").textContent).toContain("Last 7 days");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(refreshNow).not.toBeNull());
    expect(screen.queryByText("Thirty day run")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\$1,23[45]/);
    expect(screen.queryByTestId("window-read-failed")).toBeNull();

    await act(async () => refreshNow!(json(200, payload(slug, 7, 99.5, "Seven day run"))));
    await screen.findByText("Seven day run");
    expect(document.body.textContent).toContain("$99.50");
    expect(document.body.textContent).not.toMatch(/\$1,23[45]/);
    expect(screen.queryByTestId("window-read-failed")).toBeNull();
  });

  it("a failed Refresh of the same window keeps its own numbers, which are still the right ones", async () => {
    let calls = 0;
    h.fetch.mockImplementation(() => {
      calls += 1;
      return Promise.resolve(calls === 1 ? json(200, payload(slug, 30, 1234.56, "Thirty day run")) : json(400, {}));
    });
    render(<ChannelMetricsRow slug={slug} metrics={[]} platform={platform} loading={false} connected hasConnectors />);
    await screen.findByText("Thirty day run");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls).toBe(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy());
    expect(screen.getByText("Thirty day run")).toBeTruthy();
    expect(screen.queryByTestId("window-read-failed")).toBeNull();
  });
});
