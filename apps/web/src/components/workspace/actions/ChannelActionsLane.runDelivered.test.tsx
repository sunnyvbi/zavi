// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChannelActionsLane } from "./ChannelActionsLane";
import { makeAction } from "./__tests__/fixtures";
import type { ChannelDetail } from "../layout/channelDetail";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ order: () => ({ limit: async () => ({ data: [] }) }) }),
      }),
    }),
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch };
      return ch;
    },
    removeChannel: () => {},
  }),
}));

const SLUG = "pinterest_organic";
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const NOTHING = /found nothing that needs doing/;

const steps = [
  makeAction("text_post", { id: "s-1", channel_slug: SLUG, title: "Step one of the finished run" }),
  makeAction("check", { id: "s-2", channel_slug: SLUG, title: "Step two of the finished run" }),
  makeAction("fix", { id: "s-3", channel_slug: SLUG, title: "Step three of the finished run" }),
  makeAction("reply", { id: "s-4", channel_slug: SLUG, title: "Step four of the finished run" }),
];

let actions: typeof steps = [];
let actionsDelayMs = 0;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  apiFetch.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  actions = [];
  actionsDelayMs = 0;
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes(`/api/channels/${SLUG}/actions`)) {
      const body = { actions, more: 0, store: "channel_actions" };
      if (actionsDelayMs > 0) await new Promise((r) => setTimeout(r, actionsDelayMs));
      return ok(body);
    }
    if (u.includes(`/api/channels/${SLUG}/metrics`)) return ok({ metrics: [] });
    if (u.includes(`/api/channels/${SLUG}/history`)) return ok({ runs: [], closed: [], pre_switch: [] });
    return ok({});
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
  });
}

function lane(workState: ChannelDetail["workState"]) {
  return (
    <ChannelActionsLane
      slug={SLUG}
      legacy={<p>LEGACY RAIL</p>}
      workState={workState}
      lastRunAt="2026-10-23T10:00:00Z"
      actionCount={0}
      connected
      hasConnectors
    >
      <li>an approvals row</li>
    </ChannelActionsLane>
  );
}

const readsOfActions = () =>
  apiFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(`/api/channels/${SLUG}/actions`)).length;

describe("a run that finishes between two live polls", () => {
  it("re-reads the steps when the board moves to delivered and never says it found nothing", async () => {
    const r = render(lane("running"));
    await flush();
    expect(screen.getByText(/Cooking up new suggestions for Pinterest/)).toBeTruthy();
    expect(screen.queryByText(NOTHING)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await flush();
    const readsBefore = readsOfActions();

    actions = steps;
    actionsDelayMs = 1_500;
    r.rerender(lane("delivered"));
    await flush();
    expect(readsOfActions()).toBeGreaterThan(readsBefore);
    expect(screen.queryByText(NOTHING)).toBeNull();

    for (let t = 0; t < 4; t += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      await flush();
      expect(screen.queryByText(NOTHING)).toBeNull();
    }

    for (const s of steps) expect(screen.getAllByText(s.title).length).toBeGreaterThan(0);
    expect(screen.queryByText(NOTHING)).toBeNull();
    expect(screen.queryByText(/Cooking up new suggestions for Pinterest/)).toBeNull();
  });
});
