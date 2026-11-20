// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import { makeAction } from "./fixtures";
import type { ActionHandlers } from "../types";

afterEach(cleanup);
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() });

function aboutText(id: string): string {
  fireEvent.click(within(screen.getByTestId(`action-${id}`)).getByRole("button", { name: "What it is" }));
  return screen.getByRole("dialog", { name: "Details" }).textContent ?? "";
}

const BODY = [
  "This campaign has spent $607 across 29 days with zero pixel events of any kind. The daily series confirms zero every single day since Aug 26. The CTR (2-4%) is real, so the concept resonates. The problem is the campaign objective: clicks never reach a pixel-tracked page.",
  "",
  "Action #2 was raised Sep 21. Two days and $40 later it is still open. The rebuild: (1) create a new campaign with Conversions objective, (2) select the Pixel, (3) set a $20/day budget and lowest-cost bid. Pause the old campaign once the new one is live.",
].join("\n");

describe("expanding an action card", () => {
  it("keeps the lead on the card and shows the whole body once under What it is", () => {
    const a = makeAction("check", { channel_slug: "meta_ads", title: "Rebuild as a conversion campaign", body: { step: { body: BODY, effort: "hours" } } });
    render(<ChannelActionCard action={a} platform={platformFor("meta_ads")} handlers={handlers()} />);
    const card = () => screen.getByTestId(`action-${a.id}`);
    const lead = "This campaign has spent $607 across 29 days with zero pixel events of any kind.";
    expect(card().textContent).toContain(lead);

    expect(screen.queryByRole("button", { name: /^Show (more|less)$/ })).toBeNull();
    const about = aboutText(a.id);
    expect(card().textContent).toContain(lead);
    expect(about).toContain("Two days and $40 later");
    expect(about.split("The daily series confirms zero").length - 1).toBe(1);

  });
});

describe("the expansion is lossless", () => {
  it("brings back a sentence whose match type the summary stripped", () => {
    const body = "The keyword \"turo rental\" (phrase) spent $607 without a booking. Clicks land on the homepage. The homepage has no pixel. Nobody has checked the form. Two days and $40 later it is still open.";
    const a = makeAction("check", { channel_slug: "blog", title: "Fix the keyword", body: { step: { body, effort: "hours" } } });
    render(<ChannelActionCard action={a} platform={platformFor("blog")} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: /^Show (more|less)$/ })).toBeNull();
    expect(aboutText(a.id)).toContain("(phrase)");
  });
});

describe("steps under an inherited verb", () => {
  it("does not print a list item again as a derived step", () => {
    const body = "Tracking is missing on the signup page.\nSet up:\n- Pixel.\n- Conversions API.";
    const a = makeAction("check", { channel_slug: "blog", title: "Set up tracking", body: { step: { body, effort: "hours" } } });
    render(<ChannelActionCard action={a} platform={platformFor("blog")} handlers={handlers()} />);
    const text = screen.getByTestId(`action-${a.id}`).textContent ?? "";
    expect(text).toContain("Pixel.");
    expect(text).not.toContain("Set Pixel.");
    expect(aboutText(a.id)).toContain("Set up:");
  });
});

describe("a body that is only a list", () => {
  it("does not repeat the item promoted to the lead, nor leave its number behind", () => {
    const body = "1. Pause the old campaign.\n2. Launch the replacement.\n3. Move the budget over.\n4. Check the pixel fires.\n5. Watch it for a week.";
    const a = makeAction("check", { channel_slug: "blog", title: "Swap the campaign", body: { step: { body, effort: "hours" } } });
    render(<ChannelActionCard action={a} platform={platformFor("blog")} handlers={handlers()} />);
    const text = screen.getByTestId(`action-${a.id}`).textContent ?? "";
    expect(text.split("Pause the old campaign.").length - 1).toBe(1);
    expect(text.split("Launch the replacement.").length - 1).toBe(1);
    expect(text).not.toMatch(/1\.\s*Pause/);
    expect(aboutText(a.id)).toContain("Watch it for a week.");
  });
});

describe("a one-item list body", () => {
  it("offers no Show more, because nothing is hidden", () => {
    const a = makeAction("check", { channel_slug: "blog", title: "One step", body: { step: { body: "1. Pause the old campaign.", effort: "hours" } } });
    render(<ChannelActionCard action={a} platform={platformFor("blog")} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: /Show (more|less)/ })).toBeNull();
  });
});
