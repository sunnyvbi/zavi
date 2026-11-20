// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { useChannelActions } from "./useChannelActions";
import { ChannelRunDrawer } from "../layout/ChannelRunDrawer";
import { announceChannelHistoryChanged } from "./useChannelHistory";
import { makeAction } from "./__tests__/fixtures";

const SLUG = "pinterest_organic";
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });

const card = makeAction("image_post", { id: "ca-1", channel_slug: SLUG });
const RUN = {
  run_id: "run-1",
  executor: "pinterest_organic",
  trigger: "channel_recipe",
  status: "success",
  enqueued_at: "2026-10-16T06:24:20Z",
  started_at: "2026-10-16T06:24:20Z",
  finished_at: "2026-10-16T06:30:46Z",
  redo_of_action_id: null,
};
const CLOSED = {
  id: "ca-1",
  run_id: "run-1",
  position: 1,
  run_of: 3,
  action_type: "image_post",
  title: "Upload pin: Custom Birthday Cake",
  status: "acted",
  status_at: "2026-10-16T06:31:00Z",
  note: null,
  proposed_at: "2026-10-16T06:30:46Z",
  impact: 3,
  impact_reason: null,
  score: 10,
};

let cleared = false;
const historyReads = () => apiFetch.mock.calls.filter(([p]) => String(p).includes("/history")).length;

beforeEach(() => {
  cleared = false;
  apiFetch.mockReset().mockImplementation((path: string, init?: { method?: string }) => {
    const u = String(path);
    if (init?.method === "POST") {
      cleared = true;
      return ok({ ok: true });
    }
    if (u.includes(`/api/channels/${SLUG}/history`)) return ok({ runs: [RUN], closed: cleared ? [CLOSED] : [], pre_switch: [] });
    if (u.includes("/history")) return ok({ runs: [], closed: [], pre_switch: [] });
    if (u.includes("/metrics")) return ok({ metrics: [] });
    return ok({ actions: cleared ? [] : [card], more: 0, store: "channel_actions", plan: null });
  });
});
afterEach(cleanup);

describe("clearing a card updates the Runs and past items count without a page reload", () => {
  it("Done moves the card into the drawer and the count goes from 1 to 2", async () => {
    render(<ChannelRunDrawer slug={SLUG} />);
    await waitFor(() => expect(screen.getByTestId("run-drawer-count").textContent).toBe("1"));

    const { result } = renderHook(() => useChannelActions(SLUG));
    await waitFor(() => expect(result.current.actions).toHaveLength(1));

    await act(async () => {
      await result.current.handlers.onSetStatus(card, "acted");
    });

    await waitFor(() => expect(screen.getByTestId("run-drawer-count").textContent).toBe("2"));
    expect(screen.getByText("Upload pin: Custom Birthday Cake")).toBeTruthy();
  });

  it("a failed write does not re-read the history", async () => {
    render(<ChannelRunDrawer slug={SLUG} />);
    await waitFor(() => expect(screen.getByTestId("run-drawer-count").textContent).toBe("1"));
    const { result } = renderHook(() => useChannelActions(SLUG));
    await waitFor(() => expect(result.current.actions).toHaveLength(1));
    const before = historyReads();

    apiFetch.mockImplementationOnce(() => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: { message: "boom" } }) }));
    await act(async () => {
      await result.current.handlers.onSetStatus(card, "acted");
    });

    expect(historyReads()).toBe(before);
    expect(screen.getByTestId("run-drawer-count").textContent).toBe("1");
  });

  it("another channel's change does not re-read this channel's history", async () => {
    render(<ChannelRunDrawer slug={SLUG} />);
    await waitFor(() => expect(screen.getByTestId("run-drawer-count").textContent).toBe("1"));
    const before = historyReads();
    await act(async () => {
      announceChannelHistoryChanged("seo");
    });
    expect(historyReads()).toBe(before);
  });
});
