// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { setCampaignLinks } from "../campaignLinks";
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

const LONG_URL = "https://a-simple-recipe-sharing-1b7b3ae7.onrender.com/deeply/nested/path/that/never/breaks/anywhere";

const BODY = [
  "This step is blocking for any reply that names the product or includes the URL. Three things to clear before posting:",
  "",
  "1. **Email verification and account history.** The score behind the filter reads email verification, past account actions and network signals. Verify the email on the account you plan to post from, and confirm it has *some* existing comment history.",
  `2. **URL decision.** The current live URL is ${LONG_URL} and it reads as a staging link. Set \`NEXT_PUBLIC_SITE_URL\` to a [custom domain](https://example.com/domains) before you post it anywhere.`,
  "3. **Thread status.** Open <script>alert(1)</script> in a logged-out window. Then check the [dodgy one](javascript:alert(1)) before you post.",
].join("\n");

function expand(id: string) {
  fireEvent.click(within(screen.getByTestId(`action-${id}`)).getByRole("button", { name: "What it is" }));
  return screen.getByRole("dialog", { name: "Details" });
}

describe("an action card whose step text is markdown", () => {
  const blockingCheck = () =>
    makeAction("check", {
      channel_slug: "reddit_organic",
      blocking: true,
      title: "Check account eligibility before posting Answer 1",
      body: { step: { body: BODY, effort: "minutes" } },
    });

  it("renders bold, italics, inline code, lists and links instead of their source characters", () => {
    const a = blockingCheck();
    render(<ChannelActionCard action={a} platform={platformFor("reddit_organic")} handlers={handlers()} />);
    const card = expand(a.id);

    expect(card.textContent).not.toContain("**");
    expect(card.textContent).not.toContain("`NEXT_PUBLIC_SITE_URL`");
    expect(card.textContent).not.toContain("](");

    const strongs = [...card.querySelectorAll("strong")].map((e) => e.textContent);
    expect(strongs).toContain("Email verification and account history.");
    expect(strongs).toContain("URL decision.");
    expect([...card.querySelectorAll("em")].map((e) => e.textContent)).toContain("some");
    expect([...card.querySelectorAll("code")].map((e) => e.textContent)).toContain("NEXT_PUBLIC_SITE_URL");

    const items = [...card.querySelectorAll("ol > li")].map((e) => e.textContent ?? "");
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items[0]).toContain("Email verification and account history.");
  });

  it("gives every rendered link the same target and rel chat gives it", () => {
    const a = blockingCheck();
    render(<ChannelActionCard action={a} platform={platformFor("reddit_organic")} handlers={handlers()} />);
    const card = expand(a.id);

    const custom = [...card.querySelectorAll("a")].find((e) => e.textContent === "custom domain");
    expect(custom, "the markdown link must render as an anchor").toBeTruthy();
    expect(custom?.getAttribute("href")).toBe("https://example.com/domains");
    expect(custom?.getAttribute("target")).toBe("_blank");
    expect(custom?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("lets no script element or javascript: href through the sanitizer", () => {
    const a = blockingCheck();
    render(<ChannelActionCard action={a} platform={platformFor("reddit_organic")} handlers={handlers()} />);
    const card = expand(a.id);

    expect(card.querySelector("script")).toBeNull();
    for (const anchor of card.querySelectorAll("a")) {
      expect(anchor.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
    }
    expect(card.innerHTML).not.toContain("<script");
  });

  it("prints a numbered body once, in order, inside an anywhere-wrapping block", () => {
    const a = blockingCheck();
    render(<ChannelActionCard action={a} platform={platformFor("reddit_organic")} handlers={handlers()} />);
    const card = screen.getByTestId(`action-${a.id}`);

    expect(card.textContent!.split("Thread status.").length - 1, "no second copy of the numbered steps").toBe(1);
    const rest = card.querySelector("ul") as HTMLElement;
    expect(rest.closest("[class*='overflow-wrap:anywhere']"), "a long URL must break mid-token rather than run off the card").toBeTruthy();
    const items = [...rest.querySelectorAll("li")].map((e) => e.textContent ?? "");
    expect(items[0]).toContain("Email verification");
    expect(items[1]).toContain("URL decision");
    expect(items[2]).toContain("Thread status");

    const about = expand(a.id);
    const longLink = [...about.querySelectorAll("a")].find((e) => e.getAttribute("href") === LONG_URL);
    expect(longLink, "the bare long URL must render as a link, not as overflowing text").toBeTruthy();
  });

  it("keeps the title row, the Blocking pill and the copy button on raw markdown source", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const raw = "Our rule:\n\n1. **Write it down.**\n2. Ask when it last happened.";
    const a = makeAction("check", {
      channel_slug: "reddit_organic",
      blocking: true,
      title: "Check account eligibility before posting Answer 1",
      card_kind: "copy_to_site",
      body: { step: { body: BODY, effort: "minutes", deliverable: { kind: "comment", label: "Reply", content: raw } } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("reddit_organic")} handlers={handlers()} />);
    const card = screen.getByTestId(`action-${a.id}`);

    expect(within(card).getByRole("heading", { level: 4 }).textContent).toBe(
      "Check account eligibility before posting Answer 1",
    );
    expect(within(card).getByText("Do this first")).toBeTruthy();

    fireEvent.click(within(card).getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Copy/ }));
    expect(writeText).toHaveBeenCalledWith(raw);
  });

});
