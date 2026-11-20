// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import type { GadsPayload } from "../../agent/google-ads/types";
import { ChannelDetailPage, type ChannelDetail } from "../ChannelDrawer";
import { makeAction } from "../../actions/__tests__/fixtures";
import { __resetAgentDashCache } from "../../agent/dashboard-ui";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/responsive", () => ({
  useIsCompact: () => true,
  useMediaMatch: () => true,
  COMPACT_MAX_PX: 639,
  COMPACT_QUERY: "(max-width: 639px)",
}));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div /> }));

const googleAds = (CHANNELS as readonly Channel[]).find((c) => c.slug === "google_ads")!;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const RANKED = makeAction("update_ad", {
  id: "ca-1",
  channel_slug: "google_ads",
  title: "Raise the budget on the campaign that is capped",
});

function payload(): GadsPayload {
  return {
    connected: true,
    error_code: null,
    window_days: 30,
    period: { from: "2026-08-17", to: "2026-09-15" },
    prev_period: { from: "2026-07-18", to: "2026-08-16" },
    account: { name: "The main account", customer_id: "123-456-7890", campaign_count: 8 },
    kpis: [
      { key: "spend", label: "Spend", unit: "usd", value: 18420, prev: 16446, delta_pct: 12, delta_abs: 1974, delta_good: null },
    ],
    campaigns: [],
    totals: { campaigns: 8, spend: 18420, conversions: 338, cpa: 54.5, conv_value: 57400, roas: 3.12 },
    actions: [],
    counts: { all: 0, needs_you: 0, autonomous: 0 },
  } as unknown as GadsPayload;
}

const detail = (): ChannelDetail => ({
  channel: googleAds,
  mode: "produce",
  connected: true,
  connectors: ["google_ads"],
  workState: "delivered",
  lastRunAt: new Date().toISOString(),
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
});

async function openPage() {
  const view = render(
    <ChannelDetailPage
      detail={detail()}
      actionCount={0}
      error={null}
      onClose={() => {}}
      onOpenConnectors={() => {}}
      leading={
        <button type="button" aria-label="Back to channels">
          back
        </button>
      }
    />,
  );
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
  fireEvent.click(screen.getByRole("tab", { name: "Analytics" }));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return view;
}

const classesOf = (el: Element | null | undefined) =>
  (el && typeof el.className === "string" ? el.className : "").split(/\s+/);

const pageHeader = () =>
  screen.getByRole("heading", { name: "Google Ads" }).closest("div.border-b") as HTMLElement;

const nameBox = () =>
  screen.getByRole("heading", { name: "Google Ads" }).parentElement as HTMLElement;

const picker = () => document.querySelector('[aria-haspopup="listbox"]')?.parentElement as HTMLElement;
const refresh = () => screen.getByRole("button", { name: /Refresh|Reading/ });

beforeEach(() => {
  __resetAgentDashCache?.();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/channels/google_ads/actions"))
      return ok({ actions: [RANKED], more: 0, store: "channel_actions" });
    if (u.includes("/api/channels/google_ads/history"))
      return ok({ runs: [], closed: [], pre_switch: [] });
    if (u.includes("/api/agents/google_ads/dashboard")) return ok(payload());
    return ok({ snapshots: [], artifacts: [], briefs: [], metrics: [] });
  });
});

afterEach(cleanup);

describe("the channel page's one header row on a phone", () => {
  it("keeps the window picker and Refresh in one box that cannot break across lines", async () => {
    await openPage();

    expect(picker()).toBeTruthy();
    const controls = picker().parentElement as HTMLElement;
    expect(refresh().parentElement).toBe(controls);
    expect(classesOf(controls)).toContain("compact:flex-nowrap");
    expect(classesOf(controls)).not.toContain("compact:w-full");
    expect(classesOf(controls)).not.toContain("compact:justify-start");
  });

  it("puts that box in the SAME row as the back arrow and the channel name", async () => {
    await openPage();

    const row = pageHeader();
    expect(row.contains(picker())).toBe(true);
    expect(row.contains(refresh())).toBe(true);
    expect(row.contains(screen.getByRole("button", { name: "Back to channels" }))).toBe(true);
  });

  it("never caps the name with a percentage of the row, which is what crushed it to five characters", async () => {
    await openPage();

    const controls = picker().parentElement?.parentElement as HTMLElement;
    for (const cls of [...classesOf(nameBox()), ...classesOf(controls)]) {
      expect(cls).not.toMatch(/max-w-\[\d+%\]/);
    }
    expect(classesOf(nameBox())).toContain("compact:flex-none");
    expect(classesOf(controls)).toContain("compact:ml-auto");
  });

  it("collapses the controls box on a channel that has none, so it costs no gap", async () => {
    await openPage();

    const controls = picker().parentElement?.parentElement as HTMLElement;
    expect(classesOf(controls)).toContain("compact:empty:hidden");
  });

  it("draws no account line, so nothing can push the row wider than the page", async () => {
    await openPage();

    expect(screen.queryByTestId("account-strip")).toBeNull();
    const row = screen.getByTestId("channel-header");
    expect(row.textContent).not.toMatch(/campaigns?\b/);
  });
});
