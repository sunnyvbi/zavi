// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import { ChannelPanel } from "../ChannelPanel";
import { ChannelPlanLockProvider, type ChannelPlanLock } from "../../actions/channelPlanLock";
import { __resetAgentDashCache } from "../../agent/dashboard-ui";
import type { ChannelDetail } from "../channelDetail";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div /> }));

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const at = new Date(Date.now() - 3 * 3600_000).toISOString();
const dash = {
  connected: true,
  manual_publish: true,
  research_summary: null,
  suggestions: [],
  insights: {
    has_data: true,
    sweep: {
      enabled: true,
      last: {
        id: "s1",
        status: "complete",
        trigger: "manual",
        started_at: at,
        finished_at: at,
        posts_scanned: 10,
        comments_scanned: 5,
        communities_scanned: 2,
        error_code: null,
      },
      budget: { used_usd_7d: 1, cap_usd_7d: 10, exhausted: false },
      stale: false,
    },
  },
};

const detail: ChannelDetail = {
  channel: (CHANNELS as readonly Channel[]).find((c) => c.slug === "reddit_organic")!,
  mode: "produce",
  connected: true,
  connectors: ["reddit"],
  workState: "delivered",
  lastRunAt: new Date().toISOString(),
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
};

const sweepCalls = () => apiFetch.mock.calls.filter((c) => String(c[0]) === "/api/reddit/sweep").length;

async function mount(lock: ChannelPlanLock | null) {
  render(
    <ChannelPlanLockProvider value={lock}>
      <ChannelPanel detail={detail} actionCount={0} onOpenConnectors={() => {}} />
    </ChannelPlanLockProvider>,
  );
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  __resetAgentDashCache();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/dashboard")) return ok(dash);
    if (u.includes("/actions")) return ok({ actions: [], more: 0, store: "channel_actions" });
    if (u.includes("/history")) return ok({ runs: [], closed: [], pre_switch: [] });
    if (u.includes("/settings")) return ok({ fields: {} });
    return ok({ snapshots: [], artifacts: [], briefs: [], metrics: [] });
  });
});
afterEach(cleanup);

describe("Scan now and the plan", () => {
  it("on a channel the plan does not include: the upgrade, and no scan", async () => {
    const upgrade = vi.fn();
    await mount({ tierName: "Starter", upgrade });
    fireEvent.click(await screen.findByLabelText("Scan now"));
    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(sweepCalls()).toBe(0);
  });

  it("on an open channel it scans as before", async () => {
    const upgrade = vi.fn();
    await mount({ tierName: null, upgrade });
    fireEvent.click(await screen.findByLabelText("Scan now"));
    await waitFor(() => expect(sweepCalls()).toBe(1));
    expect(upgrade).not.toHaveBeenCalled();
  });
});
