// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: 0, openAgentTab: vi.fn(), openTab: vi.fn() }),
}));

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: (path: string, init?: unknown) => apiFetch(path, init) }));

vi.mock("@/lib/workspace/channelActionsApi", () => ({
  setChannelAction: vi.fn(async () => ({})),
  approve: vi.fn(async () => ({})),
  redoChannelAction: vi.fn(async () => ({})),
}));
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision: vi.fn(async () => ({ ok: true })) }));

import { ChannelsPanel, clearChannelBoardCache, RUNNING_POLL_MS } from "./ChannelsPanel";
import { announceChannelRunStarted } from "../actions/topActions/api";

let workState: "idle" | "running" | "delivered";

const channelsCalls = () => apiFetch.mock.calls.filter(([p]) => p === "/api/channels").length;

beforeEach(() => {
  clearChannelBoardCache();
  apiFetch.mockReset();
  window.localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  apiFetch.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/approvals"))
      return { ok: true, json: async () => ({ decisions: [], channel_pending_counts: {}, run_not_done_counts: {} }) };
    if (path === "/api/channels")
      return {
        ok: true,
        json: async () => ({
          channels: [
            {
              channel_slug: "pinterest_organic",
              delivery_mode: "produce",
              work_state: workState,
              priority: 1,
              last_run_at: new Date().toISOString(),
              connected: true,
              connectors: [],
              runnable: true,
            },
          ],
        }),
      };
    return { ok: true, json: async () => ({}) };
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush();
}

describe("the board while a channel run is in flight", () => {
  it("drops Working on it within one poll of the run finishing, without a reload or refocus", async () => {
    workState = "running";
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    await vi.waitFor(() => expect(screen.getAllByText("Working on it").length).toBeGreaterThan(0));

    workState = "delivered";
    await advance(RUNNING_POLL_MS + 50);

    expect(screen.queryByText("Working on it")).toBeNull();
  });

  it("learns of a run started on the page and then of it finishing", async () => {
    workState = "idle";
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    await vi.waitFor(() => expect(channelsCalls()).toBe(1));
    expect(screen.queryByText("Working on it")).toBeNull();

    workState = "running";
    act(() => announceChannelRunStarted("pinterest_organic"));
    await vi.waitFor(() => expect(screen.getAllByText("Working on it").length).toBeGreaterThan(0));

    workState = "delivered";
    await advance(RUNNING_POLL_MS + 50);
    expect(screen.queryByText("Working on it")).toBeNull();

    const settled = channelsCalls();
    await advance(RUNNING_POLL_MS * 6);
    expect(channelsCalls()).toBe(settled);
  });

  it("arms no poll when nothing is running", async () => {
    workState = "delivered";
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    await vi.waitFor(() => expect(channelsCalls()).toBe(1));
    await advance(RUNNING_POLL_MS * 6);
    expect(channelsCalls()).toBe(1);
  });
});
