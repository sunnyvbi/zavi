// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { withCardEvents } from "../cardEvents";
import type { ActionHandlers, PlatformSpec } from "../types";
import { makeAction } from "./fixtures";

const trackEvent = vi.fn();
vi.mock("@/lib/analytics/events", () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...args),
  trackEventDeferred: (...args: unknown[]) => {
    const timer = setTimeout(() => trackEvent(...args), 0);
    return () => clearTimeout(timer);
  },
}));

type Watch = { el: Element; cb: IntersectionObserverCallback; live: boolean };
const watches: Watch[] = [];
class FakeObserver {
  private mine: Watch[] = [];
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    const w = { el, cb: this.cb, live: true };
    this.mine.push(w);
    watches.push(w);
  }
  disconnect() {
    for (const w of this.mine) w.live = false;
  }
}
vi.stubGlobal("IntersectionObserver", FakeObserver);

function reveal() {
  act(() => {
    for (const w of watches.filter((x) => x.live)) w.cb([{ isIntersecting: true, target: w.el } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
}

afterEach(() => {
  cleanup();
  trackEvent.mockClear();
  watches.length = 0;
});

const handlers = () => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn() }) satisfies ActionHandlers;

const card = (over: Parameters<typeof makeAction>[1] = {}) =>
  makeAction("fix", {
    channel_slug: "seo",
    title: "Secret card title",
    card_kind: "task",
    how_to: ["Open the page settings.", "Save the new title."],
    body: { step: { body: "Secret card body text." } },
    ...over,
  });

const calls = (event: string) => trackEvent.mock.calls.filter(([name]) => name === event).map(([, props]) => props);

function expectNoCardText() {
  const sent = JSON.stringify(trackEvent.mock.calls);
  expect(sent).not.toContain("Secret");
  expect(sent).not.toContain("page settings");
}

describe("action card events", () => {
  it("card_shown fires once, only when the card is on screen, with ids and no card text", () => {
    const a = card();
    const h = handlers();
    const { rerender } = render(<ChannelActionCard action={a} handlers={h} />);
    rerender(<ChannelActionCard action={{ ...a }} handlers={h} />);
    expect(calls("card_shown")).toHaveLength(0);
    reveal();
    reveal();
    expect(calls("card_shown")).toHaveLength(1);
    expect(calls("card_shown")[0]).toEqual({
      action_id: a.id,
      action_type: "fix",
      channel: "seo",
      card_kind: "task",
      executable: false,
      status: "pending",
      tenant_id: null,
    });
    expectNoCardText();
  });

  it("card_opened fires when the founder opens How it works or What it is", () => {
    const a = card();
    render(<ChannelActionCard action={a} handlers={handlers()} />);
    const steps = screen.getByRole("button", { name: "How it works" });
    fireEvent.click(steps);
    fireEvent.click(steps);
    fireEvent.click(screen.getByRole("button", { name: "What it is" }));
    expect(calls("card_opened")).toEqual([
      expect.objectContaining({ action_id: a.id, section: "how-it-works" }),
      expect.objectContaining({ action_id: a.id, section: "what-it-is" }),
    ]);
    expectNoCardText();
  });

  it("card_opened fires on the email card too", () => {
    const a = card({ channel_slug: "email_marketing" });
    render(<ChannelActionCard action={a} platform={{ workCard: true } as PlatformSpec} handlers={handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "What it is" }));
    expect(calls("card_opened")).toEqual([expect.objectContaining({ action_id: a.id, section: "what-it-is" })]);
    expectNoCardText();
  });

  it("card_primary_clicked fires on the main button and still runs it", async () => {
    const a = card({ card_kind: null });
    const h = handlers();
    render(<ChannelActionCard action={a} handlers={h} />);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(h.onSetStatus).toHaveBeenCalled());
    expect(h.onSetStatus.mock.calls[0].slice(0, 2)).toEqual([expect.objectContaining({ id: a.id }), "acted"]);
    expect(calls("card_primary_clicked")).toEqual([expect.objectContaining({ action_id: a.id, action: "done" })]);
    expect(calls("card_dismissed")).toHaveLength(0);
    expectNoCardText();
  });

  it("card_dismissed fires when the founder dismisses the card and still dismisses it", async () => {
    const a = card();
    const h = handlers();
    render(<ChannelActionCard action={a} handlers={h} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Dismiss/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Not relevant for us/ }));
    expect(h.onSetStatus).toHaveBeenCalledWith(expect.objectContaining({ id: a.id }), "rejected", expect.objectContaining({ note: "Not relevant for us" }));
    await waitFor(() => expect(calls("card_dismissed")).toEqual([expect.objectContaining({ action_id: a.id, reason: "rejected" })]));
    expect(calls("card_primary_clicked")).toHaveLength(0);
    expectNoCardText();
  });

  it("card_dismissed stays silent when the dismiss is refused or fails", async () => {
    const a = card();
    const refused = withCardEvents({ ...handlers(), onSetStatus: vi.fn(async () => false) }, "t-1");
    const failed = withCardEvents({ ...handlers(), onSetStatus: vi.fn(async () => { throw new Error("save failed"); }) }, "t-1");
    await refused.onSetStatus(a, "rejected", { note: "Not relevant for us" });
    await expect(failed.onSetStatus(a, "snoozed")).rejects.toThrow("save failed");
    await Promise.resolve();
    expect(calls("card_dismissed")).toHaveLength(0);
  });

  it("a card settled by a post or an answer check is not counted as a Done click", async () => {
    const a = card();
    const wrapped = withCardEvents(handlers(), "t-1");
    await wrapped.onSetStatus(a, "acted", { keep: true, via: "publish" });
    await wrapped.onSetStatus(a, "acted", { keep: true, via: "answer_check" });
    expect(calls("card_primary_clicked").map((p) => p.action)).toEqual(["publish", "answer_check"]);
  });
});
