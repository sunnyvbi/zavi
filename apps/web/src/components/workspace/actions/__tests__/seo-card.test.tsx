// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";

afterEach(cleanup);
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

const handlers = (over: Partial<ActionHandlers> = {}): ActionHandlers => ({
  onSetStatus: vi.fn(async () => true),
  onRedo: vi.fn(),
  onApprove: vi.fn(async () => true),
  onOpenChat: vi.fn(),
  ...over,
});

const fixCard = () => makeAction("fix", {
  channel_slug: "seo",
  title: "Replace uncrawlable homepage links with standard anchor tags",
  card_kind: "task",
  primary_label: "Review homepage",
  body: {
    intent: "fix_setup",
    link: "https://upcar.ai/",
    step: { body: "Some links on the homepage are buttons with no address, so Google can't follow them.\n- Swap them for real <a href> links.\n- Run Lighthouse again to check." },
  },
});

const prCard = () => makeAction("fix", {
  channel_slug: "seo",
  title: "Point /upcar-ai at the homepage with a canonical tag",
  executable: true,
  primary_label: "Open pull request",
  body: {
    intent: "improve",
    step: { body: "Zavi opens a pull request on your site's repo. You merge it." },
    exact_change: { rows: [{ item: "Canonical on /upcar-ai", before: "/upcar-ai", after: "upcar.ai/" }] },
  },
});

const card = (id: string) => screen.getByTestId(`action-${id}`);

describe("seo action card", () => {
  it("renders the new card: kind, title, lead, bullets, no channel mark", () => {
    const a = fixCard();
    render(<ChannelActionCard action={a} platform={platformFor("seo")} handlers={handlers()} />);
    expect(within(card(a.id)).getByTestId("action-kind").textContent).toBe("Fix");
    expect(within(card(a.id)).getByRole("heading", { name: a.title })).toBeTruthy();
    expect(card(a.id).textContent).toContain("Swap them for real <a href> links.");
    expect(card(a.id).querySelector("[data-testid='action-mark']")).toBeNull();
    expect(within(card(a.id)).getByRole("button", { name: "What it is" })).toBeTruthy();
    expect(within(card(a.id)).getByRole("button", { name: /How it works/ })).toBeTruthy();
  });

  it("opens the page from the main button, then marks it reviewed", async () => {
    const onSetStatus = vi.fn(async () => true);
    const a = fixCard();
    render(<ChannelActionCard action={a} platform={platformFor("seo")} handlers={handlers({ onSetStatus })} />);
    const link = within(card(a.id)).getByRole("link", { name: /Review homepage/ });
    expect(link.getAttribute("href")).toBe("https://upcar.ai/");
    fireEvent.click(link);
    await act(async () => fireEvent.click(within(card(a.id)).getByRole("button", { name: "I reviewed it" })));
    expect(onSetStatus).toHaveBeenCalledWith(a, "acted", expect.anything());
  });

  it("sends an Ask Zavi question to the channel chat", () => {
    const onOpenChat = vi.fn();
    const a = fixCard();
    render(<ChannelActionCard action={a} platform={platformFor("seo")} handlers={handlers({ onOpenChat })} />);
    fireEvent.click(within(card(a.id)).getByRole("button", { name: "Ask Zavi" }));
    const ask = screen.getByRole("dialog", { name: "Ask Zavi" });
    fireEvent.change(within(ask).getByRole("textbox"), { target: { value: "Which links?" } });
    fireEvent.click(within(ask).getByRole("button", { name: "Send" }));
    expect(onOpenChat).toHaveBeenCalledWith(a, "Which links?");
  });

  it("closes the card from the close icon", async () => {
    const onSetStatus = vi.fn(async () => true);
    const a = fixCard();
    render(<ChannelActionCard action={a} platform={platformFor("seo")} handlers={handlers({ onSetStatus })} />);
    await act(async () => fireEvent.click(within(card(a.id)).getByRole("button", { name: `Close “${a.title}”` })));
    expect(onSetStatus).toHaveBeenCalledWith(a, "rejected", expect.objectContaining({ keep: true }));
  });

  it("shows the exact change before and after, with Reject beside Open pull request", () => {
    const a = prCard();
    render(<ChannelActionCard action={a} platform={platformFor("seo")} handlers={handlers()} />);
    expect(within(card(a.id)).getByTestId("action-kind").textContent).toBe("Improve results");
    const change = within(card(a.id)).getByTestId("exact-change");
    expect(change.textContent).toContain("Canonical on /upcar-ai");
    expect(change.querySelector(".line-through")?.textContent).toBe("/upcar-ai");
    expect(change.textContent).toContain("upcar.ai/");
    expect(within(card(a.id)).getByRole("button", { name: "Reject" })).toBeTruthy();
    expect(within(card(a.id)).queryByRole("button", { name: "Ask Zavi" })).toBeNull();
  });

  it("approves the pull request from the main button", async () => {
    const onApprove = vi.fn(async () => true);
    const a = prCard();
    render(<ChannelActionCard action={a} platform={platformFor("seo")} handlers={handlers({ onApprove })} />);
    await act(async () => fireEvent.click(within(card(a.id)).getByRole("button", { name: "Open pull request" })));
    expect(onApprove).toHaveBeenCalledWith(a);
  });

  it("rejects with an optional reason", async () => {
    const onSetStatus = vi.fn(async () => true);
    const a = prCard();
    render(<ChannelActionCard action={a} platform={platformFor("seo")} handlers={handlers({ onSetStatus })} />);
    const open = within(card(a.id)).getByRole("button", { name: "Reject" });
    fireEvent.click(open);
    fireEvent.change(within(card(a.id)).getByRole("textbox", { name: "Why are you rejecting it?" }), { target: { value: "Keep the old URL" } });
    const submit = within(card(a.id)).getAllByRole("button", { name: "Reject" }).find((b) => b !== open)!;
    await act(async () => fireEvent.click(submit));
    expect(onSetStatus).toHaveBeenCalledWith(a, "rejected", expect.objectContaining({ note: "Keep the old URL" }));
  });

  it("leads with the plain explanation and moves the exact tags into What it is, as code", () => {
    const explain = "/upcar-ai has the same title as the homepage, so the two pages compete for the same search. Redirect it to the homepage, or give it its own title.";
    const tags = ["Option A: 301 redirect /upcar-ai to the homepage", "Option B (if the page stays): replace the head tags with:", "<title>About Upcar | Peer-to-Peer Car Rental</title>", '<link rel="canonical" href="https://www.upcar.ai/upcar-ai">'].join("\n");
    const a = makeAction("fix", { channel_slug: "seo", title: "Give /upcar-ai its own title", body: { step: { body: explain, deliverable: { kind: "copy", content: tags } } } });
    render(<ChannelActionCard action={a} platform={platformFor("seo")} handlers={handlers()} />);
    expect(card(a.id).textContent).toContain(explain);
    expect(card(a.id).textContent).not.toContain("<title>");
    fireEvent.click(within(card(a.id)).getByRole("button", { name: "What it is" }));
    const about = screen.getByRole("dialog");
    expect(about.textContent).toContain("Option A: 301 redirect");
    expect(about.querySelector("pre code")?.textContent).toContain("<title>About Upcar | Peer-to-Peer Car Rental</title>");
    expect(about.textContent).not.toContain(explain);
  });
});
