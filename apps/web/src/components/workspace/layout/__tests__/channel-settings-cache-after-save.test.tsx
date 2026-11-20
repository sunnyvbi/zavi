// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";

const server = vi.hoisted(() => ({
  landing: "https://acme.test/old",
  readsFail: false,
  puts: [] as string[],
}));
const SETTINGS = "/api/channels/linkedin_ads/settings";

vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => "tenant-a" }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../actions/managed-campaigns/AdsAccountSettings", () => ({ AdsAccountSettings: () => null }));
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "PUT" && path === `${SETTINGS}/landing_page`) {
      const { items } = JSON.parse(String(init.body)) as { items: { item: string }[] };
      server.landing = items[0].item;
      server.puts.push(server.landing);
      const saved = [{ item: server.landing, status: "tracking" }];
      return { ok: true, status: 200, json: async () => ({ fields: { landing_page: saved } }) };
    }
    if (path.startsWith(SETTINGS)) {
      if (server.readsFail) return { ok: false, status: 503, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ fields: { landing_page: [{ item: server.landing, status: "tracking" }] } }),
      };
    }
    const body = path.startsWith("/api/channels/linkedin_ads/actions")
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

const NEW = "https://acme.test/new";
const quiet = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
};
const openSettings = () => fireEvent.click(screen.getByRole("tab", { name: /Settings/ }));
const mount = () => render(<ChannelPanel detail={detail} actionCount={0} onOpenConnectors={() => undefined} />);

beforeEach(() => {
  server.landing = "https://acme.test/old";
  server.readsFail = false;
  server.puts.length = 0;
});
afterEach(cleanup);

describe("channel settings after a save", () => {
  it("coming back to the channel shows the saved value even when every later read fails", async () => {
    mount();
    await quiet();
    openSettings();
    const input = await screen.findByDisplayValue("https://acme.test/old");

    server.readsFail = true;
    fireEvent.change(input, { target: { value: NEW } });
    fireEvent.click(screen.getAllByRole("button", { name: /^Save/ })[0]);
    await waitFor(() => expect(server.puts).toEqual([NEW]));
    await quiet();

    cleanup();
    mount();
    await quiet();
    openSettings();

    expect(screen.queryByTestId("channel-settings-skeleton")).toBeNull();
    expect(screen.getByDisplayValue(NEW)).toBeTruthy();
    expect(screen.queryByDisplayValue("https://acme.test/old")).toBeNull();
  });
});
