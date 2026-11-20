// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActionsEmpty, type ChannelRunInfo } from "./ChannelEmptyStates";
import { ChannelChatProvider, type ChannelChatPin } from "../actions/channelChat";
import type { ChannelDetail } from "./channelDetail";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [] }) }) }) }),
    }),
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: () => {},
  }),
}));

const run = (over: Partial<ChannelRunInfo> = {}): ChannelRunInfo => ({
  slug: "linkedin_organic",
  name: "LinkedIn",
  switched: false,
  priorCount: 0,
  foldBelow: false,
  onRan: () => {},
  ...over,
});

let opened: ChannelChatPin[] = [];

async function mount(
  workState: ChannelDetail["workState"],
  opts: { withColumn?: boolean; run?: ChannelRunInfo | null } = {},
) {
  const withColumn = opts.withColumn ?? true;
  const node = (
    <ActionsEmpty
      workState={workState}
      lastRunAt="2026-09-20T10:00:00Z"
      run={opts.run === undefined ? run() : opts.run}
    />
  );
  const r = render(
    withColumn ? (
      <ChannelChatProvider open={(pin) => opened.push(pin)}>{node}</ChannelChatProvider>
    ) : (
      node
    ),
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return r;
}

const door = () => screen.queryByRole("button", { name: /^(Ask Zavi about this channel|Answer Zavi in chat)$/ });

beforeEach(() => {
  opened = [];
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ channels: [] }) });
});
afterEach(cleanup);

describe("the channel's own chat door", () => {
  it.each<[string, ChannelDetail["workState"], Partial<ChannelRunInfo>]>([
    ["nobody has run it", "idle", {}],
    ["the queue is empty after a successful run", "delivered", {}],
    ["the last run failed", "needs_review", {}],
    ["the channel moved store", "idle", { switched: true, priorCount: 4 }],
  ])("is on screen when %s", async (_why, workState, over) => {
    await mount(workState, { run: run(over) });
    expect(door()).not.toBeNull();
  });

  it("opens a chat pinned to the channel, not to an action", async () => {
    await mount("delivered");
    fireEvent.click(door()!);
    expect(opened).toEqual([{ target: "channel" }]);
  });

  it("is there even where a run button is not, because asking is never wrong", async () => {
    await mount("delivered", { run: null });
    expect(door()).not.toBeNull();
    expect(screen.queryByTestId("run-channel")).toBeNull();
  });
});

describe("a surface with no second column", () => {
  it("draws no button at all", async () => {
    await mount("delivered", { withColumn: false });
    expect(door()).toBeNull();
  });

  it("and adds no empty row where there is nothing to put in it", async () => {
    const r = await mount("delivered", { withColumn: false, run: null });
    expect(r.container.querySelectorAll("button")).toHaveLength(0);
    expect(r.container.querySelectorAll("div.mt-3")).toHaveLength(0);
  });
});

describe("what the door must not change", () => {
  it("leaves the five states' own copy exactly where it was", async () => {
    await mount("delivered");
    expect(screen.getByTestId("empty-delivered")).toBeTruthy();

    cleanup();
    await mount("needs_review");
    expect(screen.getByText(/The last run didn't finish/)).toBeTruthy();

    cleanup();
    await mount("idle");
    expect(screen.getByText(/No suggestions for .* yet/)).toBeTruthy();
  });

  it("still says it is checking, with no buttons, while the switch signal is unresolved", async () => {
    await mount("idle", { run: run({ switched: "unknown" }) });
    expect(screen.getByTestId("empty-pending")).toBeTruthy();
    expect(door()).toBeNull();
    expect(screen.queryByTestId("run-channel")).toBeNull();
  });

  it("still gates the switched state on there being prior items", async () => {
    await mount("idle", { run: run({ switched: false }) });
    expect(screen.queryByTestId("empty-switched")).toBeNull();

    cleanup();
    await mount("idle", { run: run({ switched: true, priorCount: 4 }) });
    expect(screen.getByTestId("empty-switched")).toBeTruthy();
  });

  it("tells the founder a run didn't finish even on a switched channel", async () => {
    await mount("needs_review", { run: run({ switched: true, priorCount: 4 }) });
    expect(screen.queryByTestId("empty-switched")).toBeNull();
    expect(screen.getByText(/didn't finish/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Get suggestions/ })).toBeTruthy();
  });
});
