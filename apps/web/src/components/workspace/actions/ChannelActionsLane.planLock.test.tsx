// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PlatformSpec } from "./types";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));

const { spec } = vi.hoisted(() => ({ spec: { current: {} as PlatformSpec } }));
vi.mock("./platforms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platforms")>()),
  platformFor: () => spec.current,
}));

import { ChannelActionsLane } from "./ChannelActionsLane";
import { ChannelPlanLockProvider, type ChannelPlanLock } from "./channelPlanLock";
import { FIXTURES, makeAction } from "./__tests__/fixtures";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

let actions: ChannelActionView[] = [];
const publish = vi.fn(async () => true);

function route() {
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/actions")) return ok({ actions, more: 0, store: "channel_actions" });
    if (u.includes("/metrics")) return ok({ metrics: [] });
    return ok({});
  });
}

const writes = () =>
  apiFetch.mock.calls
    .filter((c) => (c[1] as { method?: string } | undefined)?.method === "POST")
    .map((c) => String(c[0]))
    .filter((u) => !u.includes("/channel-seen"));

function lane(lock: ChannelPlanLock | null, workState: "idle" | "delivered" | "needs_review" = "delivered") {
  return render(
    <ChannelPlanLockProvider value={lock}>
      <ChannelActionsLane
        slug="x_organic"
        legacy={<p>legacy rail</p>}
        workState={workState}
        lastRunAt="2026-10-13T10:00:00Z"
        actionCount={0}
        connected
        hasConnectors
      >
        {null}
      </ChannelActionsLane>
    </ChannelPlanLockProvider>,
  );
}

const post: ChannelActionView = {
  ...FIXTURES.text_post,
  id: "p1",
  title: "The 3pm slump post",
  plan_day: null,
  plan_day_source: null,
  series: null,
} as ChannelActionView;
const fix = makeAction("fix", { id: "f1", title: "Add a header image" });
const fixNext = makeAction("check", { id: "f2", title: "Tidy the footer links" });

beforeEach(() => {
  apiFetch.mockReset();
  publish.mockClear();
  spec.current = { name: "X", publish } as PlatformSpec;
  Element.prototype.scrollIntoView = () => {};
  route();
});
afterEach(cleanup);

describe("a plan-locked channel that is open to read", () => {
  it("draws its cards, and Post and Schedule open the upgrade without posting", async () => {
    actions = [post];
    const upgrade = vi.fn();
    lane({ tierName: "Starter", upgrade });
    const card = (await screen.findByTestId("action-p1")).parentElement!;
    expect(within(card).getByText("The 3pm slump post")).toBeTruthy();

    fireEvent.click(within(card).getByRole("button", { name: "Post on X" }));
    await waitFor(() => expect(upgrade).toHaveBeenCalledTimes(1));
    expect(publish).not.toHaveBeenCalled();

    fireEvent.click(within(card).getByRole("button", { name: "Schedule" }));
    expect(upgrade).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("day-picker")).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("the founder can still choose Not now or Done", async () => {
    actions = [post, { ...fix, blocking: true }, fixNext];
    const upgrade = vi.fn();
    lane({ tierName: "Starter", upgrade });
    const fixCard = await screen.findByTestId("action-f1");
    fireEvent.click(within(fixCard).getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Not now$/ }));
    fireEvent.click(await within(fixCard).findByRole("button", { name: "1 week" }));
    await waitFor(() => expect(writes()).toEqual(["/api/channel-actions/f1"]));
    const nextCard = await screen.findByTestId("action-f2");
    fireEvent.click(within(nextCard).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(writes()).toEqual(["/api/channel-actions/f1", "/api/channel-actions/f2"]));
    const sent = apiFetch.mock.calls
      .filter((c) => /^\/api\/channel-actions\/f[12]$/.test(String(c[0])))
      .map((c) => (JSON.parse(String((c[1] as { body: string }).body)) as { action: string }).action);
    expect(sent).toEqual(["snoozed", "acted"]);
    expect(upgrade).not.toHaveBeenCalled();
  });

  it("with every card closed it says the first round is over, not found nothing", async () => {
    actions = [];
    const upgrade = vi.fn();
    lane({ tierName: "Starter", upgrade });
    const state = await screen.findByTestId("empty-first-round-done");
    expect(state.textContent).toContain("That was your first roundOn Starter, Zavi finds new steps every week.");
    expect(document.body.textContent).not.toContain("found nothing");
    expect(screen.queryByRole("button", { name: "Get suggestions" })).toBeNull();
  });
});

describe("an open channel on the same lane", () => {
  it("Post posts and Schedule opens the day picker", async () => {
    actions = [post];
    const upgrade = vi.fn();
    lane({ tierName: null, upgrade });
    const card = (await screen.findByTestId("action-p1")).parentElement!;
    fireEvent.click(within(card).getByRole("button", { name: "Schedule" }));
    expect(screen.getByTestId("day-picker")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Post on X" }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(upgrade).not.toHaveBeenCalled();
  });

  it("with nothing open it reads no pending steps, with Run it again", async () => {
    actions = [];
    lane(null);
    expect(await screen.findByTestId("empty-delivered")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Get suggestions" })).toBeTruthy();
  });
});
