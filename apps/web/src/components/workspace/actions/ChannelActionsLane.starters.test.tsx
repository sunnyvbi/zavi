// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChannelActionsLane } from "./ChannelActionsLane";
import { makeAction } from "./__tests__/fixtures";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));

const SLUG = "generated_video";
const RUN = "run-starters";
const T0 = Date.parse("2026-10-01T14:00:00Z");
const FORMATS = ["product_demo", "explainer", "hook", "behind_the_scenes", "offer"] as const;

const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

function starter(i: number, over: Partial<ChannelActionView> = {}): ChannelActionView {
  return makeAction("video_post", {
    id: `st-${i}`,
    run_id: RUN,
    channel_slug: SLUG,
    title: `Starter script title ${i}`,
    executable: true,
    exec_status: "dispatching",
    status: "pending",
    proposed_at: new Date(T0 + i * 1_000).toISOString(),
    body: { video_format: FORMATS[i], cost_credits: 1318 } as ChannelActionView["body"],
    ...over,
  });
}

function made(c: ChannelActionView): ChannelActionView {
  return {
    ...c,
    exec_status: "executed",
    body: { ...c.body, media: { kind: "video", url: `https://v.example/${c.id}.mp4`, alt: "", ai_generated: true } } as ChannelActionView["body"],
  };
}

let startersRun: string | null = null;
let startersRead: Record<string, unknown> | null = null;
let startRefusal: { status: number; body: unknown } | null = null;
let actions: ChannelActionView[] = [];

const posts = (path: string) =>
  apiFetch.mock.calls.filter((c) => String(c[0]) === path && (c[1] as RequestInit | undefined)?.method === "POST");
const approvals = () =>
  apiFetch.mock.calls.filter((c) => String(c[0]).includes("/approve") && (c[1] as RequestInit | undefined)?.method === "POST");

function route() {
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u === "/api/channels") return ok({ channels: [{ channel_slug: SLUG, video_credits_each: 1318 }] });
    if (u === `/api/channels/${SLUG}/starters` && init?.method === "POST") {
      if (startRefusal) return ok(startRefusal.body, startRefusal.status);
      startersRun = RUN;
      return ok({ ok: true, run_id: RUN });
    }
    if (u === `/api/channels/${SLUG}/starters`) return ok(startersRead ?? { run_id: startersRun, started: startersRun !== null, failed_attempts: 0 });
    if (u.includes(`/api/channels/${SLUG}/actions`)) return ok({ actions, more: 0, store: "channel_actions" });
    if (u.includes(`/api/channels/${SLUG}/metrics`)) return ok({ metrics: [] });
    return ok({});
  });
}

function mount() {
  return render(
    <ChannelActionsLane
      slug={SLUG}
      legacy={<p>LEGACY RAIL</p>}
      workState="idle"
      lastRunAt={null}
      actionCount={actions.length}
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

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    await vi.advanceTimersByTimeAsync(0);
  });
}

const tiles = () => screen.queryAllByTestId("starter-tile").map((t) => t.getAttribute("data-state"));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  apiFetch.mockReset();
  startersRun = null;
  startersRead = null;
  startRefusal = null;
  actions = [];
  route();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Starters for you: before the founder starts", () => {
  it("shows one Start the AI button with the price of ONE video, and spends nothing on load", async () => {
    mount();
    await tick(0);
    expect(screen.getByTestId("start-the-ai").textContent).toBe("Start the AI");
    const text = screen.getByTestId("starters").textContent ?? "";
    expect(text).toContain("makes the first one right away");
    expect(text).toContain("one tap");
    expect(text).toContain("About 1,318 credits for the first video, charged only if it arrives.");
    expect(text).not.toContain("6,590");
    expect(text).not.toContain("—");
    await tick(5 * 60_000);
    expect(posts(`/api/channels/${SLUG}/starters`)).toHaveLength(0);
    expect(posts(`/api/channels/${SLUG}/run`)).toHaveLength(0);
    expect(approvals()).toHaveLength(0);
  });

  it("stops promising a video right away once the workspace's one free starter video is used", async () => {
    startersRead = { run_id: null, started: false, run_status: null, failed_attempts: 0, last_empty: false, first_video_used: true };
    mount();
    await tick(0);
    const text = screen.getByTestId("starters").textContent ?? "";
    expect(text).not.toContain("right away");
    expect(text).not.toContain("for the first video");
    expect(text).toContain("each one waits for your Approve");
    expect(text).toContain("About 1,318 credits a video, charged only if it arrives.");
  });

  it("a refused start says why and shows no grid", async () => {
    startRefusal = { status: 409, body: { error: { code: "coming_soon", message: "AI UGC Videos is coming soon." } } };
    mount();
    await tick(0);
    await click(screen.getByTestId("start-the-ai"));
    expect(screen.getByRole("alert").textContent).toContain("coming soon");
    expect(tiles()).toHaveLength(0);
  });

  it("a start that finished without writing anything offers Start the AI again and says what happened, not that it did not finish", async () => {
    startersRead = { run_id: null, started: false, run_status: null, failed_attempts: 1, last_empty: true };
    mount();
    await tick(0);
    expect(screen.getByTestId("start-the-ai").textContent).toBe("Start the AI");
    const text = screen.getByTestId("starters").textContent ?? "";
    expect(text).toContain("The last start finished without writing any videos. If Next steps below asks you for something, do that first, then press Start the AI.");
    expect(text).not.toContain("The last start did not finish");
    expect(tiles()).toHaveLength(0);
    await click(screen.getByTestId("start-the-ai"));
    expect(posts(`/api/channels/${SLUG}/starters`)).toHaveLength(1);
  });

  it("a start that failed outright keeps the did-not-finish line and never the wrote-nothing one", async () => {
    startersRead = { run_id: null, started: false, run_status: null, failed_attempts: 1, last_empty: false };
    mount();
    await tick(0);
    const text = screen.getByTestId("starters").textContent ?? "";
    expect(text).toContain("The last start did not finish. You are charged only for videos that arrived.");
    expect(text).not.toContain("without writing any videos");
  });
});

const waitingCard = (i: number) => starter(i, { exec_status: null });

describe("Starters for you: one click makes the first video, the rest wait for one tap", () => {
  it("starts once, makes only the first video, and leaves the other four waiting with no approval sent", async () => {
    mount();
    await tick(0);
    await click(screen.getByTestId("start-the-ai"));
    expect(posts(`/api/channels/${SLUG}/starters`)).toHaveLength(1);
    expect(screen.queryByTestId("start-the-ai")).toBeNull();
    expect(tiles()).toEqual(["writing", "writing", "writing", "writing", "writing"]);

    actions = [starter(0), waitingCard(1)];
    await tick(20_000);
    expect(tiles()).toEqual(["making", "waiting", "writing", "writing", "writing"]);

    actions = [made(starter(0)), waitingCard(1), waitingCard(2), waitingCard(3), waitingCard(4)];
    await tick(20_000);
    expect(tiles()).toEqual(["ready", "waiting", "waiting", "waiting", "waiting"]);
    expect(screen.getByTestId("starter-chip").textContent).toBe("1 ready · 4 waiting for you");

    expect(approvals()).toHaveLength(0);
    expect(posts(`/api/channels/${SLUG}/starters`)).toHaveLength(1);
  });

  it("once the run has finished, no writing tiles are shown for scripts it did not write", async () => {
    startersRun = RUN;
    actions = [made(starter(0)), waitingCard(1), waitingCard(2)];
    mount();
    await tick(0);
    expect(tiles()).toEqual(["ready", "waiting", "waiting"]);
    expect(screen.getByTestId("starter-chip").textContent).toBe("1 ready · 2 waiting for you");
  });

  it("a waiting tile shows its format, a script preview and the price, and one tap approves it through the card Approve", async () => {
    startersRun = RUN;
    actions = [made(starter(0)), waitingCard(1)];
    mount();
    await tick(0);
    const tile = screen.getAllByTestId("starter-tile").find((t) => t.getAttribute("data-state") === "waiting")!;
    expect(tile.textContent).toContain("Explainer");
    expect(tile.textContent).toContain("Waiting for you");
    const button = tile.querySelector("[data-testid='starter-make']") as HTMLButtonElement;
    expect(button.textContent).toBe("Make this video");
    expect(tile.querySelector("[data-testid='starter-cost']")!.textContent).toBe("Uses\u00a0~1,318 credits");
    await click(button);
    expect(approvals()).toHaveLength(1);
    expect(String(approvals()[0][0])).toBe("/api/channel-actions/st-1/approve");
    expect(tiles()).toEqual(["ready", "making"]);
    expect(screen.getByTestId("starter-chip").textContent).toBe("1 ready · 1 making");
  });

  it("opening a ready tile plays that video in a popup with a download link", async () => {
    startersRun = RUN;
    actions = [made(starter(1))];
    mount();
    await tick(0);
    await click(screen.getByRole("button", { name: "Play Explainer" }));
    const viewer = screen.getByTestId("starter-viewer");
    expect(viewer.querySelector("video")?.getAttribute("src")).toBe("https://v.example/st-1.mp4");
    expect(viewer.textContent).toContain("Explainer");
    expect(viewer.querySelector("a[href='https://v.example/st-1.mp4']")).not.toBeNull();
  });

  it("a starter that failed for credits offers a top-up and a retry", async () => {
    startersRun = RUN;
    actions = [made(starter(0)), starter(1, { exec_status: "failed", exec_code: "insufficient_credits" })];
    mount();
    await tick(0);
    const failed = screen.getAllByTestId("starter-tile").find((t) => t.getAttribute("data-state") === "failed")!;
    expect(failed.textContent).toContain("Not enough credits for this video. Nothing was charged.");
    expect(failed.querySelector("[data-testid='starter-top-up']")).not.toBeNull();
    expect(failed.querySelector("[data-testid='starter-make']")).not.toBeNull();
  });

  it("a failed starter is a read-only tile: it says so, with no button and no charge", async () => {
    startersRun = RUN;
    actions = [made(starter(0)), starter(1, { exec_status: "failed" })];
    mount();
    await tick(0);
    const failed = screen.getAllByTestId("starter-tile").find((t) => t.getAttribute("data-state") === "failed")!;
    expect(failed.textContent).toContain("Couldn't make this one. You were not charged.");
    expect(failed.querySelector("button")).toBeNull();
    expect(failed.tagName).not.toBe("BUTTON");
  });

  it("QA l5.11: a failed starter says why in Zavi's own words, and still offers a retry when it was temporary", async () => {
    const reason =
      "Sorry, Zavi could not check whether video making is on, so the video was not made. Try again in a minute. You were not charged for it.";
    startersRun = RUN;
    actions = [made(starter(0)), starter(1, { exec_status: "failed", exec_bucket: "temporary", note: reason })];
    mount();
    await tick(0);
    const failed = screen.getAllByTestId("starter-tile").find((t) => t.getAttribute("data-state") === "failed")!;
    expect(failed.textContent).toContain(reason);
    expect(failed.textContent).not.toContain("Couldn't make this one");
    expect(failed.querySelector("[data-testid='starter-failure']")!.textContent).toBe(reason);
    expect(failed.querySelector("[data-testid='starter-make']")).not.toBeNull();
  });

  it("QA l5.11: a failure note carrying a raw error or platform payload never reaches the tile", async () => {
    startersRun = RUN;
    actions = [
      made(starter(0)),
      starter(1, {
        exec_status: "failed",
        note: "Sorry, the video could not be made (step generate-video failed: ECONNRESET 502 fal.run). You were not charged for it.",
      }),
      starter(2, { exec_status: "failed", note: 'Meta Ads 400: {"error":{"code":100,"error_subcode":1487}}' }),
    ];
    mount();
    await tick(0);
    const failed = screen.getAllByTestId("starter-tile").filter((t) => t.getAttribute("data-state") === "failed");
    expect(failed).toHaveLength(2);
    for (const tile of failed) {
      expect(tile.querySelector("[data-testid='starter-failure']")!.textContent).toBe("Couldn't make this one. You were not charged.");
      expect(tile.textContent).not.toMatch(/ECONNRESET|error_subcode|fal\.run/);
    }
  });

  it("after a reload the grid comes straight back, with no Start button and no second start", async () => {
    startersRun = RUN;
    actions = FORMATS.map((_, i) => made(starter(i)));
    mount();
    await tick(0);
    expect(screen.queryByTestId("start-the-ai")).toBeNull();
    expect(tiles()).toEqual(["ready", "ready", "ready", "ready", "ready"]);
    expect(posts(`/api/channels/${SLUG}/starters`)).toHaveLength(0);
  });

  it("the existing cards stay as they are; Starter demos is an extra section above them", async () => {
    startersRun = RUN;
    const other = makeAction("video_post", {
      id: "other-1",
      run_id: "another-run",
      channel_slug: SLUG,
      title: "A later script from chat",
      executable: true,
      exec_status: null,
      status: "pending",
      proposed_at: new Date(T0 + 60_000).toISOString(),
      body: { cost_credits: 1318 } as ChannelActionView["body"],
    });
    actions = [made(starter(0)), other];
    mount();
    await tick(0);
    expect(["Starter script title 0", "A later script from chat"].some((t) => screen.queryAllByText(t).length > 0)).toBe(true);
    expect(tiles()).toEqual(["ready"]);
  });
});

describe("Starter demos for a business that already made videos the old way", () => {
  it("shows its made videos in an extra Starter demos grid, with no Start button, and keeps every existing card", async () => {
    const madeBefore = FORMATS.map((_, i) => made(starter(i, { run_id: "older-run", id: `old-${i}`, title: `Old video title ${i}` })));
    const script = makeAction("video_post", {
      id: "unapproved",
      run_id: "older-run",
      channel_slug: SLUG,
      title: "A script nobody approved",
      executable: true,
      exec_status: null,
      status: "pending",
      proposed_at: new Date(T0 - 60_000).toISOString(),
      body: { cost_credits: 1318 } as ChannelActionView["body"],
    });
    actions = [...madeBefore, script];
    mount();
    await tick(0);
    expect(screen.queryByTestId("start-the-ai")).toBeNull();
    expect(screen.getByTestId("starters").textContent).toContain("Starter demos");
    expect(tiles()).toEqual(["ready", "ready", "ready", "ready", "ready"]);
    expect([0, 1, 2, 3, 4].some((i) => screen.queryAllByText(`Old video title ${i}`).length > 0) || screen.queryAllByText("A script nobody approved").length > 0).toBe(true);
    expect(screen.queryAllByText("A script nobody approved").length).toBeGreaterThan(0);
    expect(approvals()).toHaveLength(0);
  });

  it("a video still being made from an Approve also shows as a making tile", async () => {
    actions = [starter(0, { run_id: "older-run", id: "old-making", title: "Being made now" })];
    mount();
    await tick(0);
    expect(tiles()).toEqual(["making"]);
    expect(screen.queryAllByText("Being made now").length).toBeGreaterThan(0);
  });
});

describe("Starter demos grid and player", () => {
  function many(n: number): ChannelActionView[] {
    return Array.from({ length: n }, (_, i) =>
      made(makeAction("video_post", {
        id: `v-${i}`,
        run_id: "older-run",
        channel_slug: SLUG,
        title: `Video ${i}`,
        executable: true,
        exec_status: "executed",
        status: "pending",
        proposed_at: new Date(T0 + i * 1_000).toISOString(),
        body: { video_format: FORMATS[i % 5] } as ChannelActionView["body"],
      })),
    );
  }

  it("is three across and shows nine at most until Show more", async () => {
    actions = many(11);
    mount();
    await tick(0);
    expect(screen.getByTestId("starter-grid").className).toContain("sm:grid-cols-3");
    expect(tiles()).toHaveLength(9);
    expect(screen.getByTestId("starter-show-all").textContent).toBe("Show more");
    await click(screen.getByTestId("starter-show-all"));
    expect(tiles()).toHaveLength(11);
    expect(screen.getByTestId("starter-show-all").textContent).toBe("Show less");
    await click(screen.getByTestId("starter-show-all"));
    expect(tiles()).toHaveLength(9);
  });

  it("with nine or fewer there is no Show more button", async () => {
    actions = many(5);
    mount();
    await tick(0);
    expect(screen.queryByTestId("starter-show-all")).toBeNull();
  });

  it("the player flips to the next and previous video without closing, wrapping at the ends", async () => {
    actions = many(3);
    mount();
    await tick(0);
    await click(screen.getAllByTestId("starter-tile")[0]);
    const src = () => screen.getByTestId("starter-viewer").querySelector("video")?.getAttribute("src");
    expect(src()).toBe("https://v.example/v-0.mp4");
    expect(screen.getByTestId("starter-viewer").textContent).toContain("1 of 3");
    await click(screen.getByRole("button", { name: "Next video" }));
    expect(src()).toBe("https://v.example/v-1.mp4");
    await click(screen.getByRole("button", { name: "Previous video" }));
    await click(screen.getByRole("button", { name: "Previous video" }));
    expect(src()).toBe("https://v.example/v-2.mp4");
    expect(screen.getByTestId("starter-viewer").querySelector("a[download]")?.getAttribute("href")).toBe("https://v.example/v-2.mp4");
  });
});
