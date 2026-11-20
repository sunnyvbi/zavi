// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { registerChannelScan, type ChannelScanHandle } from "../../layout/channelScanHandle";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";

const unregister: Array<() => void> = [];
afterEach(() => {
  cleanup();
  while (unregister.length) unregister.pop()?.();
});

const handlers = () => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() }) satisfies ActionHandlers;

const card = (over: { channel_slug?: string; type?: string } = {}) =>
  makeAction("other", {
    channel_slug: over.channel_slug ?? "geo",
    title: "Check how AI assistants answer your buyers",
    body: {
      step: {
        body: "Zavi asks these questions.",
        deliverable: { kind: "list", label: "Questions Zavi will ask", content: "1. Who fits blinds in Wimbledon?", presentation: { type: over.type ?? "answer_check" } },
      },
    },
    card_kind: "task",
    primary_label: "Check AI answers",
    done_label: "Checking",
    how_to: ["Press Check AI answers."],
  });

function mount(status: ReturnType<ChannelScanHandle["status"]>, scan: ChannelScanHandle["scan"] = vi.fn(async () => null)) {
  const handle: ChannelScanHandle = { status: () => status, scan };
  unregister.push(registerChannelScan("geo", handle));
  return handle;
}

const press = () => fireEvent.click(screen.getByRole("button", { name: "Check AI answers" }));

describe("Check AI answers card", () => {
  it("on the GEO page, presses the page's own check and marks the card done once it starts", async () => {
    const scan = vi.fn(async () => null);
    mount({ canScan: true, running: false, blockedWhy: null, ready: true, loaded: true }, scan);
    const h = handlers();
    render(<ChannelActionCard action={card()} handlers={h} />);
    press();
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.onSetStatus).toHaveBeenCalledWith(expect.objectContaining({ title: "Check how AI assistants answer your buyers" }), "acted", { keep: true }));
    expect(screen.getByTestId("primary-hint").textContent).toContain("Checking now");
  });

  it("does not start when the check can't run, says why, and leaves the card open", () => {
    const scan = vi.fn(async () => null);
    mount({ canScan: false, running: false, blockedWhy: "You've used this week's checks.", ready: true, loaded: true }, scan);
    const h = handlers();
    render(<ChannelActionCard action={card()} handlers={h} />);
    press();
    expect(scan).not.toHaveBeenCalled();
    expect(h.onSetStatus).not.toHaveBeenCalled();
    expect(screen.getByTestId("primary-hint").textContent).toBe("You've used this week's checks.");
  });

  it("a refused start keeps the card open with the reason", async () => {
    mount({ canScan: true, running: false, blockedWhy: null, ready: true, loaded: true }, vi.fn(async () => "Zavi could not start the check."));
    const h = handlers();
    render(<ChannelActionCard action={card()} handlers={h} />);
    press();
    await waitFor(() => expect(screen.getByTestId("primary-hint").textContent).toBe("Zavi could not start the check."));
    expect(h.onSetStatus).not.toHaveBeenCalled();
  });

  it("off the GEO page, the button opens the GEO page", () => {
    render(<ChannelActionCard action={card()} handlers={handlers()} />);
    const link = screen.getByRole("link", { name: "Check AI answers" });
    expect(link.getAttribute("href")).toBe("/workspace?tab=channels&channel=geo");
  });

  it("only a geo card with the answer_check presentation gets it", () => {
    mount({ canScan: true, running: false, blockedWhy: null, ready: true, loaded: true });
    render(<ChannelActionCard action={card({ type: "topic_pick" })} handlers={handlers()} />);
    expect(screen.queryByRole("link", { name: "Check AI answers" })).toBeNull();
  });
});
