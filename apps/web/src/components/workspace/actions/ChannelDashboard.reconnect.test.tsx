import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  data: null as unknown,
}));

vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), apiFetch: h.apiFetch }));
vi.mock("../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("../agent/dashboard-ui", async (orig) => ({
  ...(await orig<typeof import("../agent/dashboard-ui")>()),
  useAgentDashboard: () => ({ data: h.data, cachedAt: null, loading: false, refreshing: false, error: null, refresh: () => {}, refreshSilent: () => {} }),
}));

import { ChannelMetricsRow } from "./ChannelMetricsRow";
import { linkedin_ads } from "./platforms/linkedin_ads";

const zero = { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: null, cpc: null, cpa: null };
const revoked = {
  platform: "linkedin_ads",
  connected: true,
  error_code: "linkedin_ads_token_revoked",
  window_days: 30,
  period: { from: "2026-10-01", to: "2026-10-30" },
  account: { name: "Main", account_count: 1, campaign_count: 0, active_count: 0, currency: "USD" },
  totals: zero,
  prev_totals: zero,
  campaigns: [],
};

type Answer = { ok: boolean; status: number; json: () => Promise<unknown> };
let starts: Array<(a: Answer) => void> = [];

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
};

beforeEach(() => {
  h.data = revoked;
  starts = [];
  h.apiFetch.mockReset().mockImplementation((url: string) => {
    if (String(url).includes("/api/connectors/linkedin_ads/start")) return new Promise<Answer>((resolve) => starts.push(resolve));
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
});
afterEach(() => cleanup());

const startCalls = () => h.apiFetch.mock.calls.filter((c) => String(c[0]).includes("/start")).length;

describe("the LinkedIn 'stopped accepting Zavi's access' Reconnect", () => {
  it("must catch (Flow 33): a click in flight is shown as busy and a second click starts no second sign-in", async () => {
    render(<ChannelMetricsRow slug="linkedin_ads" metrics={[]} platform={linkedin_ads} loading={false} connected hasConnectors />);
    const notice = screen.getByTestId("channel-read-problem");
    const button = within(notice).getByRole("button", { name: "Reconnect LinkedIn Ads" });
    fireEvent.click(button);
    await flush();
    expect(button.textContent).toBe("Reconnecting…");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    await flush();
    expect(startCalls()).toBe(1);
  });

  it("must catch (Flow 33 + Flow 1): a failed start is said in plain words and the button works again, never a bare HTTP code", async () => {
    render(<ChannelMetricsRow slug="linkedin_ads" metrics={[]} platform={linkedin_ads} loading={false} connected hasConnectors />);
    const button = within(screen.getByTestId("channel-read-problem")).getByRole("button", { name: "Reconnect LinkedIn Ads" });
    fireEvent.click(button);
    await flush();
    await act(async () => starts[0]({ ok: false, status: 502, json: async () => ({}) }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Zavi couldn’t open the sign-in page just now, so nothing changed. Try again in a minute.");
    expect(screen.queryByText(/HTTP/)).toBeNull();
    expect(button.textContent).toBe("Reconnect");
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("must catch (Flow 1): a raw database error from starting the sign-in is never shown", async () => {
    render(<ChannelMetricsRow slug="linkedin_ads" metrics={[]} platform={linkedin_ads} loading={false} connected hasConnectors />);
    fireEvent.click(within(screen.getByTestId("channel-read-problem")).getByRole("button", { name: "Reconnect LinkedIn Ads" }));
    await flush();
    await act(async () => starts[0]({ ok: false, status: 500, json: async () => ({ error: { code: "state_mint_failed", message: "new row violates row-level security policy for table \"oauth_states\"" } }) }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Zavi couldn’t open the sign-in page just now, so nothing changed. Try again in a minute.");
    expect(screen.queryByText(/row-level|oauth_states/)).toBeNull();
  });

  it("must not catch: a start refusal the server words for the founder is shown as it is", async () => {
    render(<ChannelMetricsRow slug="linkedin_ads" metrics={[]} platform={linkedin_ads} loading={false} connected hasConnectors />);
    fireEvent.click(within(screen.getByTestId("channel-read-problem")).getByRole("button", { name: "Reconnect LinkedIn Ads" }));
    await flush();
    const words = "This connector isn’t available yet. Zavi hasn’t finished setting it up; email support@zaviagent.com if you need it turned on.";
    await act(async () => starts[0]({ ok: false, status: 503, json: async () => ({ error: { code: "connector_misconfigured", message: words } }) }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe(words);
  });
});

describe("a founder with shared-wallet campaigns who never connected LinkedIn", () => {
  it("must catch: the banner button says Connect, not Reconnect, and starts one sign-in", async () => {
    h.data = { ...revoked, error_code: null, own_connected: false, account: { ...revoked.account, name: "Zavi shared wallet" } };
    render(<ChannelMetricsRow slug="linkedin_ads" metrics={[]} platform={linkedin_ads} loading={false} connected hasConnectors />);
    const notice = screen.getByTestId("channel-read-problem");
    expect(within(notice).queryByRole("button", { name: /Reconnect/ })).toBeNull();
    const button = within(notice).getByRole("button", { name: "Connect LinkedIn Ads" });
    expect(button.textContent).toBe("Connect");
    fireEvent.click(button);
    await flush();
    expect(button.textContent).toBe("Connecting…");
    expect(startCalls()).toBe(1);
  });
});

describe("a founder who connected LinkedIn but has not chosen an ad account", () => {
  const unchosen = { ...revoked, error_code: null, account: null, totals: null, prev_totals: null };

  it("is shown a required step that cannot be dismissed, and Connect ad account opens this channel's Settings without a sign-in", async () => {
    h.data = unchosen;
    const tabs: unknown[] = [];
    const onTab = (e: Event) => tabs.push((e as CustomEvent).detail);
    window.addEventListener("zavi:channel-tab", onTab);
    render(<ChannelMetricsRow slug="linkedin_ads" metrics={[]} platform={linkedin_ads} loading={false} connected hasConnectors />);
    expect(screen.queryByTestId("channel-read-problem")).toBeNull();
    const step = screen.getByTestId("channel-setup-step");
    expect(step.className).not.toMatch(/warn/);
    expect(step.textContent).toMatch(/^Connect your ad account to get started\./);
    expect(within(step).queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(within(step).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(within(step).getByRole("button", { name: "Connect ad account" }));
    await flush();
    window.removeEventListener("zavi:channel-tab", onTab);
    expect(tabs).toEqual([{ slug: "linkedin_ads", tab: "settings" }]);
    expect(startCalls()).toBe(0);
  });

  it("a revoked login still shows as a warning with Reconnect", () => {
    render(<ChannelMetricsRow slug="linkedin_ads" metrics={[]} platform={linkedin_ads} loading={false} connected hasConnectors />);
    expect(screen.queryByTestId("channel-setup-step")).toBeNull();
    expect(screen.getByTestId("channel-read-problem").className).toMatch(/warn/);
  });
});
