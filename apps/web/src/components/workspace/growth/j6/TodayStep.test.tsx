// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const m = vi.hoisted(() => ({ approve: vi.fn(), done: vi.fn() }));
vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), approveCard: m.approve, readDoneWeek: m.done }));

import { TodayStep } from "./TodayStep";
import type { OpenCard } from "./api";

const pause = (over: Partial<OpenCard> = {}) =>
  ({
    source: "channel_action", id: "pause-1", channel_slug: "linkedin_ads", kind: "spend", title: "Pause the LinkedIn campaign Spring",
    body: null, why: null, where: null, card_kind: "executes", primary_label: "Approve", amount: null, effect: "Pause Spring",
    tone: null, snoozed_until: null, created_at: "2026-10-30T00:00:00Z", options: null, url: null, mins: null, campaign_id: "1",
    platform: "linkedin_ads", account_id: "2", can_redo: false, approve_blocked: null, opens_review: false, stops_live_spend: true,
    exec_failed_at: null, ...over,
  }) as OpenCard;

function harness(first: OpenCard[], money: { forecast?: unknown; leftUsd?: number | null } = {}) {
  const say = vi.fn();
  const reload = vi.fn(async () => undefined);
  let body: ReactNode = null;
  const props = {
    failed: false, forecast: (money.forecast ?? null) as never, leftUsd: money.leftUsd ?? null, say, close: vi.fn(), reload, onSummary: vi.fn(),
    overlay: (o: unknown) => { body = (o as { body: ReactNode }).body; },
  };
  const view = render(<TodayStep cards={first} {...props} />);
  return {
    say, reload,
    show: (cards: OpenCard[]) => view.rerender(<TodayStep cards={cards} {...props} />),
    dialog: () => {
      fireEvent.click(screen.getByRole("button", { name: /approve/i }));
      const modal = render(<>{body}</>);
      const text = modal.container.textContent ?? "";
      modal.unmount();
      return text;
    },
    approve: async () => {
      fireEvent.click(screen.getByRole("button", { name: /approve/i }));
      const modal = render(<>{body}</>);
      await act(async () => {
        fireEvent.click(within(modal.container).getByRole("button", { name: "Approve" }));
      });
      modal.unmount();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  m.approve.mockReset();
  m.approve.mockResolvedValue({ ok: true });
  m.done.mockReset();
  m.done.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ticked = (c: HTMLElement) => c.querySelector("[data-j6-card] svg.text-success") !== null;

describe("TodayStep after an approved spend change", () => {
  it("a queued pause never shows a tick, and a failed one comes back open saying the campaign can still spend", async () => {
    const t = harness([pause()]);
    await t.approve();
    t.show([]);
    expect(document.body.textContent).toContain("approved, applying");
    expect(ticked(document.body)).toBe(false);
    t.show([pause({ exec_failed_at: "2026-10-30T01:00:00Z", tone: "warn" })]);
    expect(document.body.textContent).not.toContain("approved, applying");
    expect(document.body.textContent).toContain("the pause did not go through. This campaign can still spend.");
    expect(t.say).toHaveBeenCalledWith(expect.stringContaining("can still spend"));
    expect(screen.getByRole("button", { name: /approve/i })).toBeTruthy();
  });
  it("re-reads while applying, so a failure arrives without the founder refreshing, and stops after the window", async () => {
    const t = harness([pause()]);
    await t.approve();
    t.show([]);
    t.reload.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(t.reload).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_600_000); });
    expect(t.reload).toHaveBeenCalledTimes(20);
  });
  it("retrying a failed pause does not flip back on the old failure still in the stale list", async () => {
    const old = "2026-10-30T01:00:00Z";
    const t = harness([pause({ exec_failed_at: old })]);
    await t.approve();
    t.show([pause({ exec_failed_at: old })]);
    expect(document.body.textContent).toContain("approved, applying");
    t.show([pause({ exec_failed_at: "2026-10-30T02:00:00Z" })]);
    expect(document.body.textContent).not.toContain("approved, applying");
  });
  it("a decision stuck after approval comes back as a check, not as approved", async () => {
    const t = harness([pause({ source: "decision", stops_live_spend: false })]);
    await t.approve();
    t.show([pause({ source: "decision", kind: "check", stops_live_spend: false })]);
    expect(document.body.textContent).not.toContain("approved, applying");
    expect(screen.getByRole("button", { name: "Check" })).toBeTruthy();
  });
});

describe("TodayStep when an approved change never comes back", () => {
  const poll = async () => {
    await act(async () => { await vi.advanceTimersByTimeAsync(20 * 15_000); });
  };
  it("must-catch: a pause that left the list and is not in done stops saying applying when the window ends, and says the campaign may still spend", async () => {
    const t = harness([pause()]);
    await t.approve();
    t.show([]);
    await poll();
    expect(document.body.textContent).not.toContain("approved, applying");
    expect(document.body.textContent).toContain("approved, not confirmed yet");
    expect(ticked(document.body)).toBe(false);
    expect(t.say).toHaveBeenCalledWith(expect.stringContaining("may still be spending"));
  });
  it("a change that shows up in done is ticked approved without waiting for the window", async () => {
    const t = harness([pause()]);
    await t.approve();
    t.show([]);
    m.done.mockResolvedValue([{ source: "channel_action", id: "pause-1", channel_slug: "linkedin_ads", title: "x", done_at: "2026-10-30T01:00:00Z", by: "zavi" }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(document.body.textContent).not.toContain("approved, applying");
    expect(ticked(document.body)).toBe(true);
  });
  it("a not-confirmed pause that later comes back failed opens again with Approve", async () => {
    const t = harness([pause()]);
    await t.approve();
    t.show([]);
    await poll();
    t.show([pause({ exec_failed_at: "2026-10-30T01:00:00Z", tone: "warn" })]);
    expect(document.body.textContent).not.toContain("not confirmed yet");
    expect(screen.getByRole("button", { name: /approve/i })).toBeTruthy();
  });
});

describe("TodayStep when the card was handled on another surface", () => {
  it.each(["illegal_transition", "already_executed"])("must-catch: %s takes the card off with plain words and a reload, no Approve left", async (code) => {
    m.approve.mockResolvedValue({ ok: false, message: "That change can't be approved from here.", body: { error: { code, message: "That change can't be approved from here." } } });
    const t = harness([pause()]);
    t.reload.mockClear();
    await t.approve();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(document.body.textContent).toContain("already handled");
    expect(ticked(document.body)).toBe(false);
    expect(t.say).toHaveBeenCalledWith(expect.stringContaining("already handled somewhere else"));
    expect(t.say).not.toHaveBeenCalledWith(expect.stringContaining("can't be approved from here"));
    expect(t.reload).toHaveBeenCalled();
  });
  it("any other refusal keeps the card open with the server's words", async () => {
    m.approve.mockResolvedValue({ ok: false, message: "Workspace access could not be checked. Try again.", body: { error: { code: "authorization_unavailable" } } });
    const t = harness([pause()]);
    await t.approve();
    expect(screen.getByRole("button", { name: /approve/i })).toBeTruthy();
    expect(t.say).toHaveBeenCalledWith("Workspace access could not be checked. Try again.");
  });
});

describe("TodayStep's ad-money forecast on a LinkedIn launch", () => {
  const forecast = { daily_usd: 10, runs_out_on: null, projected_month_usd: 300 };
  const launch = pause({ id: "launch-1", title: "Launch “Spring”: ₹25,000 total, ends Nov 20, 2026, 5:00 PM UTC", stops_live_spend: false, launch_usd: 300, launch_ends_at: Date.UTC(2026, 10, 20, 17) });
  beforeEach(() => { vi.setSystemTime(new Date(2026, 10, 3, 12)); });
  it("must-catch: counts the launch's dollars, so a budget that lasted the month now runs out", () => {
    const t = harness([launch], { forecast, leftUsd: 400 });
    const text = t.dialog();
    expect(text).not.toContain("lasts the month");
    expect(text).toMatch(/Ad money then runs out about Nov \d+/);
    expect(text).toContain("About $300 more spend by Nov 30");
  });
  it("a card with no launch money reads as before", () => {
    const t = harness([pause()], { forecast, leftUsd: 400 });
    expect(t.dialog()).toContain("Ad money then lasts the month");
  });
});
