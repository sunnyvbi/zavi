// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AdsPresentation } from "../ads/AdsPresentation";
import { platformFor } from "../platforms";
import { ChannelActionCard } from "../ChannelActionCard";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";

vi.mock("@/lib/workspace/channelActionsApi", async (orig) => ({
  ...(await orig<typeof import("@/lib/workspace/channelActionsApi")>()),
  setChannelActionSteps: vi.fn().mockResolvedValue({ ok: true, steps_done: [] }),
}));

afterEach(cleanup);
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

const handlers = (over: Partial<ActionHandlers> = {}): ActionHandlers => ({
  onSetStatus: vi.fn(),
  onRedo: vi.fn(),
  onApprove: vi.fn(),
  onOpenChat: vi.fn(),
  ...over,
});

describe("advertising cards show full content", () => {
  it.each(["meta_ads", "google_ads", "youtube_ads", "tiktok_ads", "linkedin_ads", "reddit_ads", "x_ads", "chatgpt_ads"])("%s has no Show more disclosure", (slug) => {
    const content = Array.from({ length: 30 }, (_, index) => `Creative line ${index + 1}.`).join("\n");
    const action = makeAction("create_ad", { channel_slug: slug, card_kind: "ad_manual", primary_label: "Review it", how_to: ["Check the account connection."], body: { step: { body: 'Review the complete creative. The account is connected. Your campaign stays paused. Check the destination. Set the daily budget, bid, country and the company post for "LinkedIn campaign - 2026-10-14".', deliverable: { kind: "brief", content } } } });
    const actionHandlers = handlers();
    const platform = platformFor(slug);
    render(<AdsPresentation value={{ action, handlers: actionHandlers, platform }}><ChannelActionCard action={action} handlers={actionHandlers} platform={platform} /></AdsPresentation>);
    const card = screen.getByTestId(`action-${action.id}`);
    expect(card.querySelector("[data-clamped]")).toBeNull();
    expect(card.querySelector(".lucide-sparkles, .lucide-image")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "How it works" }));
    if (slug !== "linkedin_ads") expect(card.textContent).toContain("Check the account connection.");
    expect(screen.queryByRole("button", { name: /^(Show|Read) more$/ })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "What it is" }));
    const about = screen.getByRole("dialog", { name: "Details" }).textContent ?? "";
    expect(about).toContain("Creative line 30.");
    if (slug === "linkedin_ads") expect(about).toContain("Check the account connection.");
    expect(about.split('Set the daily budget, bid, country and the company post for "LinkedIn campaign - 2026-10-14".')).toHaveLength(2);
  });
});

describe("a card's extra content is opened in place, and the control says so", () => {
  it("a setup fix keeps its steps on the card under How it works, with no Details link out to a drawer", () => {
    const a = makeAction("setup", {
      channel_slug: "pinterest_organic",
      title: "Add your website address to Company Details",
      body: {
        intent: "fix_setup",
        step: { body: "No website is on file, so no page can be checked and no pin can link anywhere.", how_to: ["Add the exact address of your studio site."] },
      },
      how_to: ["Add the exact address of your studio site."],
      card_kind: "task",
      steps_done: [],
      primary_label: "Verify",
    });
    const withDrawer = { ...handlers(), onOpenDetails: vi.fn() } as ActionHandlers;
    render(<ChannelActionCard action={a} handlers={withDrawer} />);
    expect(screen.queryByTestId("card-open-details")).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    const toggle = screen.getByRole("button", { name: "How it works" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.querySelector(".lucide-chevron-down")).not.toBeNull();
    expect(screen.queryByTestId("how-to")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("how-to").textContent).toContain("Add the exact address of your studio site.");
  });

  it("shows all card details without Show more or Show less", () => {
    const a = makeAction("check", {
      channel_slug: "made_up_site",
      body: { step: { title: "Sitemap", body: "The sitemap is stale.\n\n- Home page.\n- Pricing page.", how_to: ["Resubmit the sitemap."] } },
      card_kind: "task",
      primary_label: "Check it",
      done_label: "Done",
      how_to: ["Resubmit the sitemap."],
      steps_done: [],
    });
    render(<ChannelActionCard action={a} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: /^Show (more|less)$/ })).toBeNull();
    expect(screen.getByTestId(`action-${a.id}`).textContent).toContain("Home page.");
    expect(screen.getByTestId(`action-${a.id}`).textContent).toContain("Pricing page.");
  });
});

describe("advertising previews", () => {
  it.each(["meta_ads", "google_ads", "youtube_ads", "tiktok_ads", "linkedin_ads", "reddit_ads", "x_ads", "chatgpt_ads"])("%s shows the creative on the card", (slug) => {
    const action = makeAction("create_ad", { channel_slug: slug, body: { ad_review: { creatives: [{ title: "Campaign creative" }] } } });
    const actionHandlers = handlers();
    const platform = platformFor(slug);
    render(<AdsPresentation value={{ action, handlers: actionHandlers, platform }}><ChannelActionCard action={action} handlers={actionHandlers} platform={platform} /></AdsPresentation>);
    expect(screen.getByTestId(`action-${action.id}`).contains(screen.getByTestId("ads-preview"))).toBe(true);
    expect(screen.getByTestId("ads-preview").textContent).toContain("Campaign creative");
  });
});
