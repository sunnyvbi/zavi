// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";

const calls = vi.hoisted(() => [] as string[]);
const LANDING = "https://acme.test/demo";
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => "tenant-a" }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../actions/managed-campaigns/AdsAccountSettings", () => ({ AdsAccountSettings: () => null }));
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string) => {
    calls.push(String(url));
    const body = String(url).startsWith("/api/channels/linkedin_ads/settings")
      ? { fields: { landing_page: [{ item: LANDING, status: "tracking" }] } }
      : String(url).startsWith("/api/channels/linkedin_ads/actions")
        ? { actions: [], more: 0, store: "channel_actions" }
        : {};
    return { ok: true, status: 200, json: async () => body };
  },
}));

import { ChannelPanel } from "../ChannelPanel";
import type { ChannelDetail } from "../channelDetail";

const detail: ChannelDetail = {
  channel: (CHANNELS as readonly Channel[]).find((c) => c.slug === "linkedin_ads")!,
  mode: "produce",
  connected: true,
  connectors: [],
  workState: "delivered",
  lastRunAt: "2026-11-01T00:00:00.000Z",
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
};

const reads = (from: number, path: string) => calls.slice(from).filter((u) => u.startsWith(path)).length;
const SETTINGS = "/api/channels/linkedin_ads/settings";
const ACTIONS = "/api/channels/linkedin_ads/actions";
const tab = (name: RegExp) => fireEvent.click(screen.getByRole("tab", { name }));
const quiet = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
};
const overviewPainted = () =>
  waitFor(() => expect(screen.getByTestId("channel-overview-below").hidden).toBe(false));

beforeEach(() => {
  calls.length = 0;
});
afterEach(cleanup);

describe("the channel page's Overview and Settings tabs", () => {
  it("reads Settings while Overview shows, and opens it on that answer with no skeleton", async () => {
    render(<ChannelPanel detail={detail} actionCount={0} onOpenConnectors={() => undefined} />);
    await overviewPainted();
    await waitFor(() => expect(reads(0, SETTINGS)).toBe(1));
    await quiet();
    expect(screen.queryByTestId("channel-tab-settings")).toBeNull();

    tab(/Settings/);

    expect(screen.queryByTestId("channel-settings-skeleton")).toBeNull();
    expect(screen.getByDisplayValue(LANDING)).toBeTruthy();
  });

  it("going back and forth shows each tab at once and reads neither tab again", async () => {
    render(<ChannelPanel detail={detail} actionCount={0} onOpenConnectors={() => undefined} />);
    await overviewPainted();
    await quiet();
    expect(reads(0, ACTIONS)).toBe(1);
    tab(/Settings/);
    await screen.findByDisplayValue(LANDING);
    await quiet();
    const mark = calls.length;

    tab(/Overview/);
    expect(screen.queryByTestId("channel-overview-loading")).toBeNull();
    expect(screen.getByTestId("channel-overview-below").hidden).toBe(false);
    await quiet();

    tab(/Settings/);
    expect(screen.queryByTestId("channel-settings-skeleton")).toBeNull();
    expect(screen.getByDisplayValue(LANDING)).toBeTruthy();
    await quiet();

    tab(/Overview/);
    expect(screen.queryByTestId("channel-overview-loading")).toBeNull();
    await quiet();

    expect(reads(mark, ACTIONS)).toBe(0);
    expect(reads(mark, SETTINGS)).toBe(0);
    expect(reads(mark, "/api/channels/linkedin_ads/history")).toBe(0);
  });
});
