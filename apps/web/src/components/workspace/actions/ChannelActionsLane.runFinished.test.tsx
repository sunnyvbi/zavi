// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChannelActionsLane } from "./ChannelActionsLane";
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

const SLUG = "linkedin_organic";
const RUN_ID = "22222222-2222-2222-2222-222222222222";
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

let runStatus: "running" | "succeeded";

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  apiFetch.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  runStatus = "running";
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes(`/api/channels/${SLUG}/actions`)) return ok({ actions: [], more: 0, store: "channel_actions" });
    if (u.includes(`/api/channels/${SLUG}/metrics`)) return ok({ metrics: [] });
    if (u.includes(`/api/channels/${SLUG}/history`)) return ok({ runs: [], closed: [], pre_switch: [] });
    if (u.endsWith(`/api/channels/${SLUG}/run`)) return ok({ ok: true, run_id: RUN_ID });
    if (u.includes(`/top-actions/runs/${RUN_ID}`))
      return ok({ status: runStatus, actions: [], summary: "Your profile is set up; nothing new to post this week." });
    if (u === "/api/channels")
      return ok({
        channels: [
          {
            channel_slug: SLUG,
            run_reserve_credits: 340,
            last_run_id: RUN_ID,
            last_run_at: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      });
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

function lane(workState: ChannelDetail["workState"], lastRunAt: string | null) {
  return (
    <ChannelActionsLane
      slug={SLUG}
      legacy={<p>LEGACY RAIL</p>}
      workState={workState}
      lastRunAt={lastRunAt}
      actionCount={0}
      connected
      hasConnectors
    >
      <li>an approvals row</li>
    </ChannelActionsLane>
  );
}

describe("a run started on this page that then finishes", () => {
  it("leaves the running state as soon as the board says the run is done, not twenty minutes later", async () => {
    const before = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const r = render(lane("delivered", before));
    await flush();

    await act(async () => {
      screen.getByRole("button", { name: /Get suggestions/ }).click();
    });
    await flush();
    expect(screen.getByText(/Cooking up new suggestions for LinkedIn/)).toBeTruthy();

    const startedAt = new Date().toISOString();
    r.rerender(lane("running", startedAt));
    await flush();
    expect(screen.getByText(/Cooking up new suggestions for LinkedIn/)).toBeTruthy();

    runStatus = "succeeded";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    r.rerender(lane("delivered", startedAt));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flush();

    expect(screen.queryByText(/Cooking up new suggestions for/)).toBeNull();
    expect(screen.getByText("No new suggestions for LinkedIn")).toBeTruthy();
    expect(screen.getByText(/nothing new to post this week/)).toBeTruthy();
  });

  it("keeps the running state for a press the board has not caught up with yet", async () => {
    const before = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const r = render(lane("delivered", before));
    await flush();
    await act(async () => {
      screen.getByRole("button", { name: /Get suggestions/ }).click();
    });
    await flush();
    r.rerender(lane("delivered", before));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await flush();
    expect(screen.getByText(/Cooking up new suggestions for LinkedIn/)).toBeTruthy();
  });
});
