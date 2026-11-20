// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { ChannelActionsLane } from "./ChannelActionsLane";
import { makeAction } from "./__tests__/fixtures";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));

const SLUG = "generated_video";
const VIDEO_URL = "https://storage.example/launch-video-artifacts/t/run/talking_head.mp4?token=signed";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const script = {
  step: {
    title: "Explainer: why your order needs a day",
    body: "Approve to make this as a 20-second vertical video with an AI presenter.",
    blocking: false,
    effort: "minutes",
    evidence: [],
    deliverable: { kind: "script", label: "The script", content: "A short presenter script." },
  },
};

function card(over: Partial<ChannelActionView>): ChannelActionView {
  return makeAction("video_post", {
    id: "ca-video-1",
    channel_slug: SLUG,
    title: "Explainer: why your order needs a day",
    executable: true,
    body: script,
    ...over,
  });
}

const making = card({ exec_status: "dispatching" });
const delivered = card({
  exec_status: "executed",
  body: {
    ...script,
    media: { kind: "video", url: VIDEO_URL, alt: "", download_url: VIDEO_URL, ai_generated: true },
  } as ChannelActionView["body"],
});

let actions: ChannelActionView[] = [making];

const actionReads = () =>
  apiFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(`/api/channels/${SLUG}/actions`));

function mount() {
  return render(
    <ChannelActionsLane
      slug={SLUG}
      legacy={<p>LEGACY RAIL</p>}
      workState="delivered"
      lastRunAt="2026-10-01T11:49:27Z"
      actionCount={1}
      connected
      hasConnectors={false}
    >
      <li>an approvals row</li>
    </ChannelActionsLane>,
  );
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const videoOnPage = () => document.querySelector(`video[src="${VIDEO_URL}"]`);

beforeEach(() => {
  vi.useFakeTimers();
  apiFetch.mockReset();
  actions = [making];
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes(`/api/channels/${SLUG}/actions`)) return ok({ actions, more: 0, store: "channel_actions" });
    if (u.includes(`/api/channels/${SLUG}/metrics`)) return ok({ metrics: [] });
    return ok({});
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("an approved video card whose run finished long ago", () => {
  it("shows the video once the worker delivers it, without a reload", async () => {
    mount();
    await tick(0);
    expect(screen.queryAllByText(/Making your video/).length).toBeGreaterThan(0);
    expect(videoOnPage()).toBeNull();

    actions = [delivered];
    await tick(20_000);

    expect(videoOnPage()).not.toBeNull();
    expect(screen.queryAllByText(/Making your video/)).toHaveLength(0);
    expect(screen.queryByText(/AI-generated/)).toBeNull();
  });

  it("keeps watching across a render that takes several minutes", async () => {
    mount();
    await tick(0);
    await tick(6 * 60_000);
    expect(videoOnPage()).toBeNull();
    expect(actionReads().length).toBeGreaterThanOrEqual(60);

    actions = [delivered];
    await tick(20_000);
    expect(videoOnPage()).not.toBeNull();
  });

  it("stops reading once nothing on the page is being made", async () => {
    mount();
    await tick(0);
    actions = [delivered];
    await tick(20_000);
    expect(videoOnPage()).not.toBeNull();

    const settled = actionReads().length;
    await tick(10 * 60_000);
    expect(actionReads()).toHaveLength(settled);
  });
});

describe("how often a card being made is read", () => {
  async function readsDuring(ms: number) {
    const before = actionReads().length;
    await tick(ms);
    return actionReads().length - before;
  }

  it("reads at once, then every 3s for the first two minutes", async () => {
    mount();
    await tick(0);
    expect(actionReads().length).toBe(2);
    expect(await readsDuring(60_000)).toBe(20);
  });

  it("then every 10s until twenty minutes, then once a minute, and never stops", async () => {
    mount();
    await tick(0);
    await tick(3 * 60_000);
    expect(await readsDuring(60_000)).toBe(6);
    await tick(17 * 60_000);
    expect(await readsDuring(10 * 60_000)).toBe(10);
    await tick(3 * 60 * 60_000);
    expect(await readsDuring(10 * 60_000)).toBe(10);
    expect(screen.queryAllByText(/Making your video/).length).toBeGreaterThan(0);
  });

  it("a card that moves goes back to the fast pace", async () => {
    actions = [card({ exec_status: "queued" })];
    mount();
    await tick(0);
    await tick(15 * 60_000);
    expect(await readsDuring(60_000)).toBe(6);
    actions = [making];
    await tick(10_000);
    expect(await readsDuring(60_000)).toBe(20);
  });
});

describe("the founder acting on the page", () => {
  const plain = makeAction("text_post", { id: "plain-1", channel_slug: SLUG, title: "A plain post to mark done", proposed_at: "2026-09-15T15:00:00Z" });
  const failed = card({ exec_status: "failed", note: "The video could not be made." });

  async function press(name: string | RegExp) {
    await act(async () => {
      screen.getAllByRole("button", { name }).forEach((b) => b.click());
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  async function markPlainDone() {
    const card = screen.getAllByText("A plain post to mark done")[0]!.closest("article") as HTMLElement;
    await act(async () => {
      within(card).getByRole("button", { name: /more actions/i }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      screen.getByRole("menuitem", { name: /^Done/ }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("a failed card tried again shows its new video", async () => {
    actions = [making, plain];
    mount();
    await tick(0);
    await tick(30 * 60_000);

    actions = [failed];
    await markPlainDone();
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);

    actions = [making];
    await press("Try again");
    expect(apiFetch.mock.calls.some((c) => String(c[0]) === `/api/channel-actions/${making.id}/approve`)).toBe(true);
    expect(screen.queryAllByText(/Making your video/).length).toBeGreaterThan(0);

    actions = [delivered];
    await tick(3_000);
    expect(videoOnPage()).not.toBeNull();
  });

  it("any action by the founder brings back the fast pace even when nothing on the card changed", async () => {
    actions = [making, plain];
    mount();
    await tick(0);
    await tick(30 * 60_000);

    actions = [making];
    await markPlainDone();
    const after = actionReads().length;
    await tick(30_000);
    expect(actionReads().length - after).toBeGreaterThanOrEqual(10);
  });
});
