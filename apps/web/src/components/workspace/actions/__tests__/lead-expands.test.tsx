// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { cardCopy } from "../cardCopy";
import { platformFor } from "../platforms";
import { makeAction } from "./fixtures";
import type { ActionHandlers } from "../types";

afterEach(cleanup);
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

const handlers = (): ActionHandlers => ({
  onSetStatus: vi.fn(),
  onRedo: vi.fn(),
  onApprove: vi.fn(),
  onOpenChat: vi.fn(),
});

function aboutText(id: string): string {
  fireEvent.click(within(screen.getByTestId(`action-${id}`)).getByRole("button", { name: "What it is" }));
  return screen.getByRole("dialog", { name: "Details" }).textContent ?? "";
}

const TAIL = "The last clause carries the number that makes the whole thing worth reading: $4,120 a month.";
const LONG = `Mobile signups fell while desktop held flat, and the drop is concentrated in the two cities that carry most of the spend, which is why the weekly total moved at all. The same two cities were the only ones with a creative refresh in the window, so the change is not seasonal and not a tracking artifact. ${TAIL}`;
const PAST_THE_CAP = `Mobile signups fell while desktop held flat. The drop is concentrated in the two cities that carry most of the spend. Those two cities were the only ones with a creative refresh in the window. Neither seasonality nor a tracking change lines up with the dates. ${TAIL}`;

describe("a lead too long for the collapsed card", () => {
  it("keeps the whole body one click away under What it is", () => {
    const a = makeAction("check", { channel_slug: "blog", title: "Check the mobile signup drop", body: { step: { body: PAST_THE_CAP, effort: "hours" } } });
    render(<ChannelActionCard action={a} platform={platformFor("blog")} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: /^Show (more|less)$/ })).toBeNull();
    expect(aboutText(a.id)).toContain(TAIL);
  });

  it("does the same on an ad card", () => {
    const a = makeAction("update_ad", {
      channel_slug: "google_ads",
      title: "Raise the budget on the capped campaign",
      body: { change_sentence: LONG },
    });
    expect(cardCopy(a, false).leadCut).toBe(true);

    render(<ChannelActionCard action={a} platform={platformFor("google_ads")} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: /^Show (more|less)$/ })).toBeNull();
    expect(screen.getByTestId(`action-${a.id}`).textContent).toContain(TAIL);
  });

  it("keeps long prose fully readable behind What it is, with no Show more", () => {
    const a = makeAction("check", { channel_slug: "blog", title: "Check the drop", body: { step: { body: PAST_THE_CAP, effort: "hours" } } });
    render(<ChannelActionCard action={a} platform={platformFor("blog")} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: /^Show (more|less)$/ })).toBeNull();
    expect(aboutText(a.id)).toContain(TAIL);
  });

  it("offers no toggle when the lead already fits and there is nothing behind it", () => {
    const a = makeAction("check", { channel_slug: "blog", title: "Short one", body: { step: { body: "Mobile signups fell 38%.", effort: "hours" } } });
    expect(cardCopy(a, false).leadCut).toBe(false);
    render(<ChannelActionCard action={a} platform={platformFor("blog")} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: /Show (more|less)/i })).toBeNull();
  });
});
