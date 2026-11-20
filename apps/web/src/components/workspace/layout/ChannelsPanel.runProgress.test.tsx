// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: 0, openAgentTab: vi.fn(), openTab: vi.fn() }),
}));

const action = (id: string, position: number) => ({
  id,
  decision_class: "channel.recipe_step",
  channel_slug: "reddit_organic",
  handler: null,
  emitted_at: "2026-09-19T10:00:00.000Z",
  action_source: "channel_action" as const,
  run_group: { run_id: "run-1", position, of: 3 },
  body: { step: { title: `Step ${position} of the plan`, body: "Do the thing." } },
});

const OPEN_TWO = [action("a-2", 2), action("a-3", 3)];

let notDoneCounts: Record<string, number>;
const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: unknown) => apiFetch(path, init),
}));

const setChannelAction = vi.fn(async (_id: string, _input: { action: string }) => ({}));
vi.mock("@/lib/workspace/channelActionsApi", () => ({
  setChannelAction: (id: string, input: { action: string }) => setChannelAction(id, input),
  approve: vi.fn(async () => ({})),
  redoChannelAction: vi.fn(async () => ({})),
}));

vi.mock("@/lib/approvals/approveDecision", () => ({
  approveDecision: vi.fn(async () => ({ ok: true })),
}));

import { ChannelsPanel, clearChannelBoardCache } from "./ChannelsPanel";

beforeEach(clearChannelBoardCache);

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  notDoneCounts = {};
  apiFetch.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/approvals?channel="))
      return {
        ok: true,
        json: async () => ({
          decisions: OPEN_TWO,
          run_not_done_counts: notDoneCounts,
        }),
      };
    if (path.startsWith("/api/approvals"))
      return {
        ok: true,
        json: async () => ({
          decisions: [],
          channel_pending_counts: { reddit_organic: 2 },
          run_not_done_counts: notDoneCounts,
        }),
      };
    if (path.startsWith("/api/channels"))
      return {
        ok: true,
        json: async () => ({
          channels: [
            {
              channel_slug: "reddit_organic",
              delivery_mode: "produce",
              work_state: "needs_review",
              priority: 1,
              last_run_at: "2026-09-19T09:00:00.000Z",
              connected: false,
              connectors: [],
              runnable: true,
            },
          ],
        }),
      };
    return { ok: true, json: async () => ({}) };
  });
});

afterEach(cleanup);

async function expandTheTile(badge: string) {
  render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
  const tile = await vi.waitFor(() => {
    const t = screen
      .getAllByRole("button", { expanded: false })
      .find((b) => b.textContent?.startsWith("Reddit") && new RegExp(`(^|[^0-9])${badge} actions? waiting`).test(b.textContent ?? ""));
    if (!t) throw new Error("tile not ready");
    return t;
  });
  fireEvent.click(tile);
}

const runHeader = async () =>
  await screen.findByText(/Reddit · 2 of 3 left/);

function mockFourStepRun() {
  const of4 = (id: string, position: number) => ({
    ...action(id, position),
    run_group: { run_id: "run-1", position, of: 4 },
  });
  const open3 = [of4("a-2", 2), of4("a-3", 3), of4("a-4", 4)];
  apiFetch.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/approvals?channel="))
      return { ok: true, json: async () => ({ decisions: open3, run_not_done_counts: {} }) };
    if (path.startsWith("/api/approvals"))
      return {
        ok: true,
        json: async () => ({
          decisions: [],
          channel_pending_counts: { reddit_organic: 3 },
          run_not_done_counts: {},
        }),
      };
    if (path.startsWith("/api/channels"))
      return {
        ok: true,
        json: async () => ({
          channels: [
            {
              channel_slug: "reddit_organic",
              delivery_mode: "produce",
              work_state: "needs_review",
              priority: 1,
              last_run_at: "2026-09-19T09:00:00.000Z",
              connected: false,
              connectors: [],
              runnable: true,
            },
          ],
        }),
      };
    return { ok: true, json: async () => ({}) };
  });
}

async function openTheRun() {
  const header = await screen.findByText(/Reddit · 3 of 4 left/);
  expect(header.textContent).toBe("Reddit · 3 of 4 left · 1 done");
  fireEvent.click(header);
}

describe("a run's progress line", () => {
  it("does not call a snoozed action done", async () => {
    notDoneCounts = { "run-1": 1 };
    await expandTheTile("2");
    const header = await runHeader();
    expect(header.textContent).toBe("Reddit · 2 of 3 left");
    expect(header.textContent).not.toContain("done");
  });

  it("still calls an acted action done", async () => {
    notDoneCounts = {};
    await expandTheTile("2");
    const header = await runHeader();
    expect(header.textContent).toBe("Reddit · 2 of 3 left · 1 done");
  });

  it("counts one done and one deferred apart from each other", async () => {
    notDoneCounts = { "run-1": 1 };
    apiFetch.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/approvals?channel="))
        return {
          ok: true,
          json: async () => ({
            decisions: [{ ...action("a-4", 4), run_group: { run_id: "run-1", position: 4, of: 4 } }],
            run_not_done_counts: notDoneCounts,
          }),
        };
      if (path.startsWith("/api/approvals"))
        return {
          ok: true,
          json: async () => ({
            decisions: [
              { ...action("a-3", 3), run_group: { run_id: "run-1", position: 3, of: 4 } },
              { ...action("a-4", 4), run_group: { run_id: "run-1", position: 4, of: 4 } },
            ],
            channel_pending_counts: { reddit_organic: 2 },
            run_not_done_counts: notDoneCounts,
          }),
        };
      if (path.startsWith("/api/channels"))
        return {
          ok: true,
          json: async () => ({
            channels: [
              {
                channel_slug: "reddit_organic",
                delivery_mode: "produce",
                work_state: "needs_review",
                priority: 1,
                last_run_at: "2026-09-19T09:00:00.000Z",
                connected: false,
                connectors: [],
                runnable: true,
              },
            ],
          }),
        };
      return { ok: true, json: async () => ({}) };
    });
    await expandTheTile("2");
    const header = await screen.findByText(/Reddit · 2 of 4 left/);
    expect(header.textContent).toBe("Reddit · 2 of 4 left · 1 done");
  });

  it("books a fresh Not now as not-done, and leaves the real done alone", async () => {
    mockFourStepRun();
    await expandTheTile("3");
    await openTheRun();

    fireEvent.click(screen.getAllByRole("button", { name: "More" })[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Not now" }));
    await vi.waitFor(() =>
      expect(setChannelAction).toHaveBeenCalledWith("a-2", { action: "snoozed" }),
    );

    const after = await screen.findByText(/Reddit · 2 of 4 left/);
    expect(after.textContent).toBe("Reddit · 2 of 4 left · 1 done");
  });

  it("books a fresh Didn't do it as not-done too", async () => {
    mockFourStepRun();
    await expandTheTile("3");
    await openTheRun();

    fireEvent.click(screen.getAllByRole("button", { name: "More" })[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Didn't do it/i }));
    await vi.waitFor(() => expect(setChannelAction).toHaveBeenCalled());

    const after = await screen.findByText(/Reddit · 2 of 4 left/);
    expect(after.textContent).toBe("Reddit · 2 of 4 left · 1 done");
  });

  it("THE CONTROL: a genuine Did it still counts as done", async () => {
    mockFourStepRun();
    await expandTheTile("3");
    await openTheRun();

    fireEvent.click(screen.getAllByRole("button", { name: /^Did it$/ })[0]);
    await vi.waitFor(() =>
      expect(setChannelAction).toHaveBeenCalledWith("a-2", { action: "acted" }),
    );

    const after = await screen.findByText(/Reddit · 2 of 4 left/);
    expect(after.textContent).toBe("Reddit · 2 of 4 left · 2 done");
  });
});
