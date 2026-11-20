// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { movePlanDay, SeriesSection, ThisWeekCalendar, writeEpisodeRequest } from "./ChannelSchedule";
import { dayInTimeZone, wallTimeInZone } from "./scheduleTime";
import { FIXTURES, makeAction } from "./__tests__/fixtures";

const ok = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
  clone() {
    return this;
  },
});

const NOW = new Date(2026, 8, 29, 12, 0, 0);

const post = (id: string, title: string, over: Partial<ChannelActionView> = {}): ChannelActionView =>
  ({ ...FIXTURES.text_post, id, title, plan_day: null, plan_day_source: null, series: null, ...over }) as ChannelActionView;

let actions: ChannelActionView[] = [];
const calls: { url: string; body: unknown }[] = [];
let moveAnswer: (url: string) => ReturnType<typeof ok> | Promise<ReturnType<typeof ok>> = () => ok({});

function route() {
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST") {
      if (u.includes("/publish-on")) {
        calls.push({ url: u, body: init.body ? JSON.parse(String(init.body)) : null });
        return moveAnswer(u);
      }
      return ok({});
    }
    if (u.includes("/actions")) return ok({ actions, more: 0, store: "channel_actions" });
    if (u.includes("/metrics")) return ok({ metrics: [] });
    return ok({});
  });
}

function lane(slug: string) {
  return render(
    <ChannelActionsLane
      slug={slug}
      legacy={<p>legacy rail</p>}
      workState="idle"
      lastRunAt={null}
      actionCount={0}
      connected
      hasConnectors
    >
      {null}
    </ChannelActionsLane>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  apiFetch.mockReset();
  calls.length = 0;
  moveAnswer = () => ok({});
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const X_POSTS = () => [
  post("x1", "The 3pm slump post", { plan_day: "2026-09-30", plan_day_source: "planned" }),
  post("x2", "1,200 reorders this summer", { plan_day: "2026-10-02", plan_day_source: "planned" }),
  post("x3", "Why your tea tastes like grass", { plan_day: "2026-09-28", plan_day_source: "planned" }),
  post("x4", "Thread: how we taste 40 batches", { plan_day: "2026-09-29", plan_day_source: "scheduled" }),
  post("x5", "A post with no day yet"),
];

const IG_POSTS = () => [
  post("ig1", "Reel: steeping oolong in 30 seconds", {
    action_type: "video_post",
    plan_day: "2026-10-01",
    plan_day_source: "planned",
    series: {
      id: "brew30",
      name: "Brew in 30",
      format: "30-second Reel, one tea per episode",
      episode: 1,
      next: ["Green tea at 80C, why not boiling", "Cold brew overnight in a jar", "Batch 48 first taste"],
    },
  }),
  post("ig2", "Photo: Sunday tea tray", { action_type: "image_post", plan_day: "2026-10-04", plan_day_source: "planned" }),
];

function calendar(cards: ChannelActionView[], onOpen: (id: string) => void = () => {}) {
  return render(
    <ThisWeekCalendar cards={cards} today={NOW} needsOk={() => false} onOpen={onOpen} onMove={async () => null} />,
  );
}

async function cardOf(id: string) {
  await screen.findByTestId("action-section");
  const more = screen.queryByRole("button", { name: /^Show more$/ });
  if (more) fireEvent.click(more);
  return (await screen.findByTestId(`action-${id}`)).parentElement!;
}

const lineOf = (card: HTMLElement) => within(card).getByTestId("plan-day-line");

function pressMove(card: HTMLElement) {
  fireEvent.click(within(card).getByRole("button", { name: "Move" }));
}

function openPicker(card: HTMLElement) {
  pressMove(card);
  return screen.getByTestId("day-picker");
}

function schedule(picker: HTMLElement, day: string) {
  fireEvent.click(within(picker).getByRole("button", { name: day }));
  fireEvent.click(within(picker).getByRole("button", { name: "Schedule" }));
}

describe("the calendar on its own", () => {
  it("puts each dated post on its day, today outlined, and says the one-off posts are one-offs", () => {
    calendar(X_POSTS());
    const week = screen.getByTestId("this-week");
    expect(within(week).getByText("4 planned")).toBeTruthy();
    expect(within(screen.getByTestId("day-2026-09-30")).getByText("The 3pm slump post")).toBeTruthy();
    expect(within(screen.getByTestId("day-2026-10-02")).getByText("1,200 reorders this summer")).toBeTruthy();
    const today = screen.getByTestId("day-2026-09-29");
    expect(today.getAttribute("data-today")).toBe("true");
    expect(today.className).not.toMatch(/(^|\s)(border-ink|ring-1|ring-ink)(\s|$)/);
    expect(within(today).getByTestId("today-tag").textContent).toBe("Today");
    expect(today.textContent).not.toContain("· Today");
    expect(screen.getAllByTestId("today-tag")).toHaveLength(1);
    expect(within(screen.getByTestId("day-2026-10-03")).getByText("Nothing planned")).toBeTruthy();
    for (const id of ["x1", "x2", "x3", "x4"]) expect(screen.getByTestId(`event-${id}`).getAttribute("data-kind")).toBe("post");
    expect(screen.getByTestId("event-x4").getAttribute("data-state")).toBe("queued");
    expect(within(screen.getByTestId("event-x4")).getByText("Scheduled to post")).toBeTruthy();
    expect(within(week).queryByText("A post with no day yet")).toBeNull();
  });

  it("pressing an event's title opens its card", () => {
    const opened: string[] = [];
    calendar(X_POSTS(), (id) => opened.push(id));
    fireEvent.click(within(screen.getByTestId("event-x3")).getByRole("button", { name: "Why your tea tastes like grass" }));
    expect(opened).toEqual(["x3"]);
  });

  it("draws a series episode as a series and a photo as a one-off", () => {
    calendar(IG_POSTS());
    expect(screen.getByTestId("event-ig1").getAttribute("data-kind")).toBe("series");
    expect(screen.getByTestId("event-ig2").getAttribute("data-kind")).toBe("post");
    expect(screen.getByText("Series episode")).toBeTruthy();
  });

  it("counts a blog's dated posts", () => {
    calendar([
      post("b1", "How to brew oolong", { plan_day: "2026-09-28", plan_day_source: "planned" }),
      post("b2", "Green tea temperatures", { plan_day: "2026-10-01", plan_day_source: "planned" }),
    ]);
    expect(within(screen.getByTestId("this-week")).getByText("2 planned")).toBeTruthy();
  });

  it("is an empty week when the server sends no days", () => {
    const { plan_day: _a, plan_day_source: _b, series: _c, ...bare } = post("n1", "An undated post");
    calendar([bare as ChannelActionView]);
    const week = screen.getByTestId("this-week");
    expect(within(week).queryByTestId("week-count")).toBeNull();
    expect(week.textContent).not.toMatch(/\d+ planned/);
  });
});

describe("the series section on its own", () => {
  it("groups the episodes, opens the drafted one, and marks Write it now as asked only once the chat started", () => {
    const opened: string[] = [];
    const asks: { n: number; started: () => void; request: string }[] = [];
    render(
      <SeriesSection
        cards={IG_POSTS()}
        channelName="Instagram"
        onOpen={(id) => opened.push(id)}
        onWrite={(series, ep, started) => asks.push({ n: ep.n, started, request: writeEpisodeRequest(series, ep) })}
      />,
    );
    const s = screen.getByTestId("series-brew30");
    expect(within(s).getByText("Brew in 30")).toBeTruthy();
    expect(within(s).getByText("1 drafted, 3 planned")).toBeTruthy();
    expect(within(s).getByText("30-second Reel, one tea per episode")).toBeTruthy();
    const ep1 = screen.getByTestId("episode-brew30:1");
    expect(within(ep1).getByText("Draft ready, planned Thu")).toBeTruthy();
    fireEvent.click(within(ep1).getByRole("button", { name: "Open draft" }));
    expect(opened).toEqual(["ig1"]);
    const ep2 = screen.getByTestId("episode-brew30:2");
    expect(within(ep2).getByText("Green tea at 80C, why not boiling")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Write it now" })).toHaveLength(3);
    fireEvent.click(within(ep2).getByRole("button", { name: "Write it now" }));
    expect(asks).toHaveLength(1);
    expect(asks[0]!.n).toBe(2);
    expect(asks[0]!.request).toContain('episode 2 of the "Brew in 30" series');
    expect(within(ep2).queryByText("Asked Zavi in chat")).toBeNull();
    expect(within(ep2).getByRole("button", { name: "Write it now" })).toBeTruthy();
    act(() => asks[0]!.started());
    expect(within(ep2).getByText("Asked Zavi in chat")).toBeTruthy();
  });

  it("draws nothing when no card belongs to a series", () => {
    const { container } = render(<SeriesSection cards={X_POSTS()} channelName="X" onOpen={() => {}} />);
    expect(container.querySelector('[data-testid="series"]')).toBeNull();
  });
});

describe("X-shaped: dated one-off posts, one queued to go out, on the channel page", () => {
  beforeEach(() => {
    spec.current = { name: "X" };
    actions = [...X_POSTS(), makeAction("fix", { id: "xf", title: "Add a header image" })];
    route();
  });

  it("an undated post has no day line and a Schedule button, and no calendar or series section mounts", async () => {
    lane("x_organic");
    const card = await cardOf("x5");
    expect(within(card).queryByTestId("plan-day-line")).toBeNull();
    expect(within(card).getByRole("button", { name: "Schedule" })).toBeTruthy();
    expect(screen.queryByTestId("this-week")).toBeNull();
    expect(screen.queryByTestId("series")).toBeNull();
    expect(within(screen.getByTestId("action-section")).getByText("The 3pm slump post")).toBeTruthy();
  });

  it("the picker opens on the card's day, pages by five days and names the month", async () => {
    lane("x_organic");
    const picker = openPicker(await cardOf("x1"));
    expect(within(picker).getByText("September 2026")).toBeTruthy();
    expect(within(picker).getByRole("button", { name: "Wed Sep 30" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(picker).queryByLabelText("Hour")).toBeNull();
    fireEvent.click(within(picker).getByRole("button", { name: "Later days" }));
    expect(within(picker).getByText("October 2026")).toBeTruthy();
    expect(within(picker).getByRole("button", { name: "Mon Oct 5" })).toBeTruthy();
    fireEvent.click(within(picker).getByRole("button", { name: "Previous month" }));
    expect(within(picker).getByRole("button", { name: "Tue Sep 29" })).toBeTruthy();
    expect((within(picker).getByRole("button", { name: "Earlier days" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls).toEqual([]);
  });

  it("Move on a planned post calls publish-on and moves the card's day", async () => {
    moveAnswer = () => ok({ plan_day: "2026-10-01" });
    lane("x_organic");
    const card = await cardOf("x1");
    schedule(openPicker(card), "Thu Oct 1");
    await waitFor(() => expect(lineOf(card).textContent).toContain("Planned for Thu Oct 1"));
    expect(screen.queryByTestId("day-picker")).toBeNull();
    expect(calls).toEqual([{ url: "/api/channels/actions/x1/publish-on", body: { publish_on: "2026-10-01" } }]);
  });

  it("Move on a queued post also calls publish-on", async () => {
    moveAnswer = () => ok({ plan_day: "2026-10-03", plan_day_source: "scheduled" });
    lane("x_organic");
    const card = await cardOf("x4");
    schedule(openPicker(card), "Sat Oct 3");
    await waitFor(() => expect(lineOf(card).textContent).toContain("Goes out Sat Oct 3"));
    expect(calls).toEqual([{ url: "/api/channels/actions/x4/publish-on", body: { publish_on: "2026-10-03" } }]);
  });

  it("a post that takes a time shows it, and sends the picked time as 24h", async () => {
    actions = [post("x6", "A timed post", { plan_day: "2026-09-30", plan_day_source: "scheduled", plan_time: "09:00" })];
    moveAnswer = () => ok({ plan_day: "2026-10-01", plan_day_source: "scheduled", plan_time: "12:43" });
    lane("x_organic");
    const card = await cardOf("x6");
    expect(lineOf(card).textContent).toContain("Goes out Wed Sep 30 at 9:00 AM");
    const picker = openPicker(card);
    expect((within(picker).getByLabelText("Hour") as HTMLInputElement).value).toBe("9");
    fireEvent.change(within(picker).getByLabelText("Hour"), { target: { value: "12" } });
    fireEvent.change(within(picker).getByLabelText("Minute"), { target: { value: "43" } });
    fireEvent.click(within(picker).getByRole("button", { name: "PM" }));
    schedule(picker, "Thu Oct 1");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ publish_on: "2026-10-01", publish_time: "12:43" });
    await waitFor(() => expect(lineOf(card).textContent).toContain("Goes out Thu Oct 1 at 12:43 PM"));
  });

  it("drops the optimistic time when the refreshed card no longer has a staged proposal", async () => {
    actions = [post("x6", "A timed post", {
      plan_day: "2026-09-30",
      plan_day_source: "scheduled",
      plan_time: null,
      plan_timezone: "America/Los_Angeles",
    })];
    moveAnswer = () => {
      const { plan_time: _time, plan_timezone: _zone, ...decided } = actions[0]!;
      actions = [{ ...decided, plan_day: "2026-09-30", plan_day_source: "planned" }];
      return ok({ plan_day: "2026-10-01", plan_day_source: "scheduled", plan_time: "10:00", plan_timezone: "America/Los_Angeles" });
    };
    lane("x_organic");
    const card = await cardOf("x6");
    const picker = openPicker(card);
    fireEvent.change(within(picker).getByLabelText("Hour"), { target: { value: "10" } });
    schedule(picker, "Thu Oct 1");
    await waitFor(() => expect(lineOf(card).textContent).toContain("Planned for Wed Sep 30"));
    expect(lineOf(card).textContent).not.toContain("10:00 AM");
  });

  it("a time that is not a time, or has passed today, cannot be scheduled", async () => {
    actions = [post("x6", "A timed post", { plan_day: "2026-09-30", plan_day_source: "scheduled", plan_time: "09:00" })];
    lane("x_organic");
    const picker = openPicker(await cardOf("x6"));
    const go = () => within(picker).getByRole("button", { name: "Schedule" }) as HTMLButtonElement;
    fireEvent.change(within(picker).getByLabelText("Hour"), { target: { value: "13" } });
    expect(go().disabled).toBe(true);
    fireEvent.change(within(picker).getByLabelText("Hour"), { target: { value: "9" } });
    expect(go().disabled).toBe(false);
    fireEvent.click(within(picker).getByRole("button", { name: "Earlier days" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Tue Sep 29" }));
    expect(within(picker).getByText("That time has passed. Pick a later one.")).toBeTruthy();
    expect(go().disabled).toBe(true);
    expect(calls).toEqual([]);
  });

  it("Take off the calendar on a queued post sends null to publish-on", async () => {
    moveAnswer = () => ok({ plan_day: null, plan_day_source: null });
    lane("x_organic");
    const card = await cardOf("x4");
    fireEvent.click(within(openPicker(card)).getByRole("button", { name: "Take off the calendar" }));
    await waitFor(() => expect(within(card).queryByTestId("plan-day-line")).toBeNull());
    expect(calls).toEqual([{ url: "/api/channels/actions/x4/publish-on", body: { publish_on: null } }]);
  });

  it("a second Move on the same post while the first is in flight sends nothing", async () => {
    let answer!: (v: ReturnType<typeof ok>) => void;
    moveAnswer = () => new Promise((r) => (answer = r));
    lane("x_organic");
    const card = await cardOf("x1");
    schedule(openPicker(card), "Thu Oct 1");
    await waitFor(() => expect(calls).toHaveLength(1));
    pressMove(card);
    const again = openPicker(card);
    schedule(again, "Sat Oct 3");
    expect((await within(again).findByRole("alert")).textContent).toBe("Still moving this post.");
    expect(calls).toHaveLength(1);
    await act(async () => answer(ok({ plan_day: "2026-10-01" })));
  });

  it("a later read replaces the moved day: the server's day wins", async () => {
    moveAnswer = () => {
      actions = actions.map((a) => (a.id === "x1" ? { ...a, plan_day: "2026-10-04" } : a));
      return ok({ plan_day: "2026-10-01" });
    };
    lane("x_organic");
    const card = await cardOf("x1");
    schedule(openPicker(card), "Thu Oct 1");
    await waitFor(() => expect(lineOf(card).textContent).toContain("Planned for Sun Oct 4"));
    expect(lineOf(card).textContent).not.toContain("Thu Oct 1");
  });

  it("a 409 from the server puts the day back and shows its sentence", async () => {
    moveAnswer = () => ok({ error: { code: "not_pending", message: "This post already went out." } }, 409);
    lane("x_organic");
    const card = await cardOf("x4");
    const picker = openPicker(card);
    schedule(picker, "Sat Oct 3");
    expect((await within(picker).findByRole("alert")).textContent).toBe("This post already went out.");
    expect(lineOf(card).textContent).toContain("Goes out Tue Sep 29");
    expect(calls).toHaveLength(1);
  });

  it("a failed Move puts the day back and says why", async () => {
    moveAnswer = () => ok({ error: { message: "That post is already publishing." } }, 500);
    lane("x_organic");
    const card = await cardOf("x2");
    const picker = openPicker(card);
    schedule(picker, "Sun Oct 4");
    expect((await within(picker).findByRole("alert")).textContent).toBe("That post is already publishing.");
    expect(lineOf(card).textContent).toContain("Planned for Fri Oct 2");
    expect(lineOf(card).textContent).not.toContain("Planned for Sun Oct 4");
  });
});

describe("SEO-shaped: no posts", () => {
  it("draws no calendar and no empty Series section", async () => {
    spec.current = { name: "SEO" };
    actions = [makeAction("fix", { id: "s1", title: "Turn on the sitemap" }), makeAction("check", { id: "s2", title: "Check the index" })];
    route();
    lane("seo");
    await screen.findByText("Turn on the sitemap");
    expect(screen.queryByTestId("this-week")).toBeNull();
    expect(screen.queryByTestId("series")).toBeNull();
  });
});

describe("a server that does not send days yet", () => {
  it("draws no day line on the card", async () => {
    spec.current = { name: "X" };
    const { plan_day: _a, plan_day_source: _b, series: _c, ...bare } = post("n1", "An undated post");
    actions = [bare as ChannelActionView];
    route();
    lane("x_organic");
    await screen.findByText("An undated post");
    expect(screen.queryByTestId("plan-day-line")).toBeNull();
    expect(screen.queryByRole("button", { name: "Schedule" })).toBeNull();
  });
});

describe("movePlanDay", () => {
  it("sends null to take a post off the calendar, and returns the day the server holds", async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce(ok({ plan_day: null, plan_day_source: null }));
    expect(await movePlanDay(post("m1", "t", { plan_day: "2026-10-02", plan_day_source: "planned" }), null)).toEqual({ plan_day: null });
    expect(apiFetch.mock.calls[0]![0]).toBe("/api/channels/actions/m1/publish-on");
    expect(JSON.parse(String(apiFetch.mock.calls[0]![1].body))).toEqual({ publish_on: null });
  });

  it("throws the server's sentence on a 500", async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce(ok({ error: { message: "Could not save that day." } }, 500));
    await expect(movePlanDay(post("m2", "t"), "2026-10-02")).rejects.toThrow("Could not save that day.");
  });
});

describe("workspace time-zone helpers", () => {
  it("uses the workspace day and clock even when the browser is on another day", () => {
    const instant = new Date("2026-09-30T00:30:00.000Z");
    expect(dayInTimeZone(instant, "America/Los_Angeles")).toBe("2026-09-29");
    expect(wallTimeInZone(instant, "America/Los_Angeles")).toBe("17:30");
    expect(dayInTimeZone(instant, "Asia/Kolkata")).toBe("2026-09-30");
  });
});
