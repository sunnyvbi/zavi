import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import type { ChannelDetail } from "../channelDetail";

const h = vi.hoisted(() => ({ apiFetch: vi.fn(), changed: { current: undefined as undefined | (() => void) } }));
vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("@/components/workspace/WorkspaceShell", async (orig) => ({ ...(await orig<Record<string, unknown>>()), useWorkspaceOptional: () => ({ tenantName: "t-ads-reread" }) }));
vi.mock("../../actions/managed-campaigns/AdsAccountSettings", () => ({
  AdsAccountSettings: ({ onConnectionChange }: { onConnectionChange?: () => void }) => {
    h.changed.current = onConnectionChange;
    return null;
  },
}));

import { ChannelPanel } from "../ChannelPanel";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const detail: ChannelDetail = {
  channel: (CHANNELS as readonly Channel[]).find((c) => c.slug === "linkedin_ads")!,
  mode: "produce",
  connected: true,
  connectors: ["linkedin_ads"],
  workState: "delivered",
  lastRunAt: new Date().toISOString(),
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
};
const payload = (n: number) => ({
  platform: "linkedin_ads",
  connected: true,
  own_connected: true,
  error_code: null,
  campaigns: Array.from({ length: n }, (_, i) => ({ id: String(9000 + i), name: `Campaign ${i}`, status: "ACTIVE", spend: 0, impressions: 0, clicks: 0, conversions: 0, cpa: null, url: null, funding_source: "provider", ad_account_id: "1", currency: "USD", ad_delivery: null, ads_not_running: 0 })),
  other_campaigns: [],
  account_errors: [],
  window_days: 30,
});
const urls = () => h.apiFetch.mock.calls.map(([u]) => String(u));
const dashboardReads = () => urls().filter((u) => u.includes("/api/agents/linkedin_ads/dashboard"));
let release: (() => void) | null = null;
let held: Promise<void> | null = null;

beforeEach(() => {
  h.changed.current = undefined;
  h.apiFetch.mockReset();
  release = null;
  held = null;
  h.apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/dashboard")) {
      if (u.includes("scope=selection") && held) await held;
      return ok(payload(u.includes("scope=selection") ? 5 : 4));
    }
    if (u.includes("/actions")) return ok({ actions: [], more: 0, store: "channel_actions" });
    if (u.includes("/history")) return ok({ runs: [], closed: [], pre_switch: [] });
    return ok({ snapshots: [], artifacts: [], briefs: [], metrics: [], fields: {} });
  });
});
afterEach(cleanup);

it.each(["meta_ads", "google_ads"])("%s keeps one report mounted when switching to Analytics", async slug => {
  h.apiFetch.mockImplementation(async (url: string) => {
    if (String(url).includes("/dashboard")) return ok(slug === "meta_ads"
      ? { channels: [{ channel: "meta", connected: true, spend_usd: 300, conversions: 2, revenue_usd: 500, cpa_usd: 150, roas: 1.67, ctr_percent: 2 }], connected: { meta: true }, meta_currency: "USD", campaigns: [] }
      : { connected: true, currency: "USD", kpis: [{ key: "spend", value: 300, unit: "usd" }], campaigns: [], actions: [] });
    if (String(url).includes("/actions")) return ok({ actions: [], more: 0, store: "channel_actions" });
    if (String(url).includes("/history")) return ok({ runs: [], closed: [], pre_switch: [] });
    return ok({ snapshots: [], artifacts: [], briefs: [], metrics: [], fields: {} });
  });
  const channel = (CHANNELS as readonly Channel[]).find(c => c.slug === slug)!;
  render(<ChannelPanel detail={{ ...detail, channel, connectors: [slug] }} actionCount={0} onOpenConnectors={() => undefined} />);
  await waitFor(() => expect(screen.getByTestId("paid-analytics")).toBeTruthy());
  const reads = () => urls().filter(u => u.includes("/dashboard")).length;
  const before = reads();
  expect(screen.getAllByRole("tab", { name: "Analytics" })).toHaveLength(1);
  expect(screen.queryByTestId("channel-refresh")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Analytics" }));
  const analytics = screen.getByRole("tabpanel", { name: `${channel.name} analytics` });
  expect(within(analytics).getByTestId("paid-analytics")).toBeTruthy();
  expect(screen.getAllByTestId("channel-refresh")).toHaveLength(1);
  fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
  fireEvent.click(screen.getByRole("tab", { name: "Analytics" }));
  expect(reads()).toBe(before);
});

it("a new account for new campaigns re-reads each dashboard once without busting LinkedIn's display reads, and says it is updating until the read lands", async () => {
  render(<ChannelPanel detail={detail} actionCount={0} onOpenConnectors={() => undefined} />);
  await waitFor(() => expect(dashboardReads().length).toBeGreaterThan(0));
  await waitFor(() => expect(h.changed.current).toBeTypeOf("function"));
  await act(() => new Promise((r) => setTimeout(r, 30)));
  const before = dashboardReads().length;
  const openReads = new Set(dashboardReads());
  held = new Promise<void>((r) => {
    release = r;
  });
  await act(async () => {
    h.changed.current?.();
  });
  const rereads = dashboardReads().slice(before);
  expect(rereads.length).toBeGreaterThan(0);
  for (const u of rereads) expect(new URL(u, "http://x").searchParams.get("scope")).toBe("selection");
  expect(new Set(rereads).size).toBe(rereads.length);
  expect(rereads.length).toBe(openReads.size);
  expect((await screen.findByTestId("account-reread")).textContent).toContain("Updating campaigns and numbers");
  await act(() => new Promise((r) => setTimeout(r, 30)));
  expect(screen.getByTestId("account-reread")).toBeTruthy();
  expect(dashboardReads().length).toBe(before + rereads.length);
  await act(async () => release?.());
  await waitFor(() => expect(screen.queryByTestId("account-reread")).toBeNull());
  expect(dashboardReads().length).toBe(before + rereads.length);
});
