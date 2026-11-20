// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import type { ChannelDetail } from "../channelDetail";

const h = vi.hoisted(() => ({ apiFetch: vi.fn(), changed: { current: undefined as undefined | (() => void) }, account: { current: null as null | { hidden?: boolean; settingsPage?: boolean } } }));
vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("@/components/workspace/WorkspaceShell", async (orig) => ({ ...(await orig<Record<string, unknown>>()), useWorkspaceOptional: () => ({ tenantName: "t-ads-connection" }) }));
vi.mock("../../actions/managed-campaigns/AdsAccountSettings", () => ({
  AdsAccountSettings: ({ onConnectionChange, hidden, settingsPage }: { onConnectionChange?: () => void; hidden?: boolean; settingsPage?: boolean }) => {
    h.changed.current = onConnectionChange;
    h.account.current = { hidden, settingsPage };
    return null;
  },
}));

import { ChannelPanel } from "../ChannelPanel";
import { APPROVALS_CHANGED_EVENT } from "../../actions/topActions/api";

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
const dashboardReads = () => h.apiFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/api/agents/linkedin_ads/dashboard"));

beforeEach(() => {
  h.changed.current = undefined;
  h.apiFetch.mockReset();
  h.apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/dashboard")) return ok({ connected: true, error_code: "linkedin_ads_token_revoked", campaigns: [], metrics: [] });
    if (u.includes("/actions")) return ok({ actions: [], more: 0, store: "channel_actions" });
    if (u.includes("/history")) return ok({ runs: [], closed: [], pre_switch: [] });
    return ok({ snapshots: [], artifacts: [], briefs: [], metrics: [], fields: {} });
  });
});
afterEach(cleanup);

it("a new LinkedIn connection re-reads the dashboard the page really draws and the channel board, once the channel row has no payload key", async () => {
  render(<ChannelPanel detail={detail} actionCount={0} onOpenConnectors={() => undefined} />);
  await waitFor(() => expect(dashboardReads().length).toBeGreaterThan(0));
  await waitFor(() => expect(h.changed.current).toBeTypeOf("function"));
  const board = vi.fn();
  window.addEventListener(APPROVALS_CHANGED_EVENT, board);
  const before = dashboardReads().filter((u) => u.includes("refresh=1")).length;
  await act(async () => { h.changed.current?.(); });
  await waitFor(() => expect(dashboardReads().filter((u) => u.includes("refresh=1")).length).toBeGreaterThan(before));
  expect(board).toHaveBeenCalledTimes(1);
  window.removeEventListener(APPROVALS_CHANGED_EVENT, board);
});

it("the LinkedIn ad account block stays mounted on every tab and shows only on Settings, opened", async () => {
  render(<ChannelPanel detail={detail} actionCount={0} onOpenConnectors={() => undefined} />);
  await waitFor(() => expect(h.account.current).toEqual({ hidden: true, settingsPage: true }));
  fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));
  await waitFor(() => expect(h.account.current).toEqual({ hidden: false, settingsPage: true }));
  fireEvent.click(screen.getByRole("tab", { name: /^Overview/ }));
  await waitFor(() => expect(h.account.current).toEqual({ hidden: true, settingsPage: true }));
});
