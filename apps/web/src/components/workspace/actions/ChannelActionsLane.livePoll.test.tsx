// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChannelActionsLane } from "./ChannelActionsLane";
import { makeAction } from "./__tests__/fixtures";
import type { ChannelDetail } from "../layout/channelDetail";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const SLUG = "linkedin_organic";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const first = makeAction("text_post", {
  id: "ca-1",
  channel_slug: SLUG,
  title: "The first action the run wrote",
});
const second = makeAction("check", {
  id: "ca-2",
  channel_slug: SLUG,
  title: "The sixth action the run wrote",
});

let actions = [first];

function route() {
  actions = [first];
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes(`/api/channels/${SLUG}/actions`)) {
      return ok({ actions, more: 0, store: "channel_actions" });
    }
    if (u.includes(`/api/channels/${SLUG}/metrics`)) return ok({ metrics: [] });
    return ok({});
  });
}

const actionReads = () =>
  apiFetch.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes(`/api/channels/${SLUG}/actions`));

function mount(workState: ChannelDetail["workState"], reloadExtra?: () => void) {
  return render(
    <ChannelActionsLane
      slug={SLUG}
      extraCards={reloadExtra ? { cards: [], position: "before", settled: true, reload: reloadExtra } : undefined}
      legacy={<p>LEGACY RAIL</p>}
      workState={workState}
      lastRunAt="2026-09-20T10:00:00Z"
      actionCount={0}
      connected
      hasConnectors
    >
      <li>an approvals row</li>
    </ChannelActionsLane>,
  );
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  apiFetch.mockReset();
  route();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a run in flight", () => {
  it("re-reads the ranked list on its own, and the new action appears", async () => {
    mount("running");
    await settle();
    expect(actionReads()).toHaveLength(1);
    expect(screen.queryAllByText("The first action the run wrote").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("The sixth action the run wrote")).toHaveLength(0);

    actions = [first, second];
    await tick(20_000);

    expect(actionReads().length).toBeGreaterThan(1);
    expect(screen.queryAllByText("The sixth action the run wrote").length).toBeGreaterThan(0);
  });

  it("keeps re-reading, so a twelve-minute run does not go quiet after one tick", async () => {
    mount("running");
    await settle();
    await tick(60_000);
    expect(actionReads().length).toBeGreaterThanOrEqual(4);
  });

  it("never flashes the loading state, so the rows stay on screen across a tick", async () => {
    mount("running");
    await settle();

    let seenMidTick = -1;
    apiFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes(`/api/channels/${SLUG}/actions`)) {
        seenMidTick = screen.queryAllByText("The first action the run wrote").length;
        return ok({ actions: [first, second], more: 0, store: "channel_actions" });
      }
      return ok({ metrics: [] });
    });

    await tick(20_000);
    expect(seenMidTick).toBeGreaterThan(0);
    expect(screen.queryAllByText("The first action the run wrote").length).toBeGreaterThan(0);
  });

  it("stops when the page goes away", async () => {
    const r = mount("running");
    await settle();
    const before = actionReads().length;
    r.unmount();
    await tick(120_000);
    expect(actionReads()).toHaveLength(before);
  });
});

describe("the creator cards beside a run", () => {
  it("re-read with the ranked list, so a brief the run wrote shows without a page reload", async () => {
    const reloadExtra = vi.fn();
    mount("running", reloadExtra);
    await settle();
    expect(reloadExtra).not.toHaveBeenCalled();
    await tick(20_000);
    expect(reloadExtra).toHaveBeenCalledTimes(1);
    await tick(40_000);
    expect(reloadExtra).toHaveBeenCalledTimes(3);
  });

  it("stay quiet when no run is in flight", async () => {
    const reloadExtra = vi.fn();
    mount("delivered", reloadExtra);
    await settle();
    await tick(5 * 60_000);
    expect(reloadExtra).not.toHaveBeenCalled();
  });
});

describe("a channel with no run in flight", () => {
  it.each<ChannelDetail["workState"]>(["idle", "delivered", "needs_review"])(
    "issues no extra reads at all (%s)",
    async (workState) => {
      mount(workState);
      await settle();
      const afterMount = actionReads().length;
      await tick(5 * 60_000);
      expect(actionReads()).toHaveLength(afterMount);
    },
  );
});

describe("a run the founder starts on a page that is already open", () => {
  async function pressRun() {
    actions = [];
    mount("delivered");
    await settle();
    const button = screen.getByTestId("run-channel");
    await act(async () => {
      button.click();
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("watches for the actions the run writes, though workState still says delivered", async () => {
    await pressRun();
    const afterPress = actionReads().length;

    actions = [first];
    await tick(20_000);
    expect(actionReads().length).toBeGreaterThan(afterPress);
    expect(screen.queryAllByText("The first action the run wrote").length).toBeGreaterThan(0);
  });

  it("gives up after the watch window rather than polling all day", async () => {
    await pressRun();
    await tick(21 * 60_000);
    const settled = actionReads().length;
    await tick(5 * 60_000);
    expect(actionReads()).toHaveLength(settled);
  });
});
