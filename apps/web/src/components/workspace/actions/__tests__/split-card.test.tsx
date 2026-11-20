// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { FIXTURES, makeAction } from "./fixtures";

afterEach(cleanup);

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
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

const menuLabels = () => screen.getAllByRole("menuitem").map((m) => m.querySelector(":scope > span > span")?.textContent ?? m.textContent);

const footerControls = (card: HTMLElement) => within(within(card).getByTestId("card-footer")).getAllByRole("button").map((b) => b.textContent?.trim() || b.getAttribute("aria-label"));

const openAbout = (card: HTMLElement) => {
  fireEvent.click(within(card).getByRole("button", { name: "What it is" }));
  return screen.getByRole("dialog", { name: "Details" }).textContent ?? "";
};

const openEditor = () => {
  const visible = screen.queryByRole("button", { name: "Edit" });
  if (visible) {
    fireEvent.click(visible);
    return;
  }
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Edit/ }));
};

describe("a card with nothing but its lead", () => {
  it("renders the lead alone, never an empty grey panel", () => {
    const a = makeAction("other", {
      channel_slug: "blog",
      title: "Think about the pricing page",
      body: { action_label: "Do it", step: { body: "The pricing page has not changed in a year.", effort: "hours" } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("blog")} handlers={handlers()} />);
    const card = screen.getByTestId(`action-${a.id}`);
    expect(card.textContent).toContain("The pricing page has not changed in a year.");
    expect(within(card).queryByTestId("exact-change")).toBeNull();
    expect([...card.querySelectorAll(".bg-ca-subtle")].filter((e) => !e.textContent?.trim())).toHaveLength(0);
  });

  it("FALSIFIER: a card with an exact change shows it on the card", () => {
    render(<ChannelActionCard action={FIXTURES.pause_ad} platform={platformFor("google_ads")} handlers={handlers()} />);
    const card = screen.getByTestId(`action-${FIXTURES.pause_ad.id}`);
    expect(within(card).getByTestId("exact-change")).toBeTruthy();
  });
});

describe("MONEY INVARIANT: the exact change is shown before approve, in full", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ item: `Campaign ${i + 1} daily budget`, before: `$${20 + i}`, after: `$${40 + i}` }));
  const a = makeAction("update_ad", {
    channel_slug: "google_ads",
    title: "Raise 30 budgets",
    executable: true,
    body: { action_label: "Apply change", exact_change: { rows }, step: { body: "b", deliverable: { kind: "brief", label: "Brief", content: "line\n".repeat(40) } } },
  });

  it("is visible without a click and never clamped, however long", () => {
    render(<ChannelActionCard action={a} platform={platformFor("google_ads")} handlers={handlers()} />);
    const change = screen.getByTestId("exact-change");
    expect(change.querySelectorAll('[data-testid="exact-change-row"]')).toHaveLength(30);
    expect(change.textContent).toContain("Campaign 30 daily budget");
    expect(change.closest("[data-clamped]")).toBeNull();
    expect(change.closest(".overflow-hidden.max-h-\\[220px\\]")).toBeNull();
    const about = openAbout(screen.getByTestId(`action-${a.id}`));
    const seen = `${screen.getByTestId(`action-${a.id}`).textContent} ${about}`;
    expect(seen).toContain("line\nline");
  });

  it("sits in the card before the approve button", () => {
    render(<ChannelActionCard action={a} platform={platformFor("google_ads")} handlers={handlers()} />);
    const change = screen.getByTestId("exact-change");
    const approve = screen.getByRole("button", { name: "Apply change" });
    expect(change.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the footer is the primary, Ask Zavi and ···", () => {
  it("ActionCard: ··· holds Ask Zavi, Copy, the done words and Not now beside Edit and the primary", () => {
    const h = handlers();
    render(<ChannelActionCard action={{ ...FIXTURES.send_message, channel_slug: "sms", card_kind: "message" }} platform={platformFor("sms")} handlers={h} />);
    const card = screen.getByTestId(`action-${FIXTURES.send_message.id}`);
    expect(footerControls(card)).toEqual(["How it works", "What it is", "More actions", "Edit", "Copy text"]);
    fireEvent.click(within(card).getByRole("button", { name: "More actions" }));
    expect(menuLabels()).toEqual(["Ask Zavi", "Copy", "Done", "Not now"]);
  });

  it("Copy in ··· takes the WHOLE deliverable even though the card clips it", async () => {
    const content = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the page copy.`).join("\n");
    const a = makeAction("page", { channel_slug: "geo", title: "Publish the page", card_kind: "copy_to_site", body: { action_label: "Open the page", step: { body: "b", deliverable: { kind: "page", label: "Page copy", content } } } });
    render(<ChannelActionCard action={a} platform={platformFor("geo")} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: "Read more" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Copy/ }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(content);
  });

  it("a long deliverable is clipped on the card and whole in What it is, with no Read more", () => {
    const content = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}.`).join("\n");
    const a = makeAction("page", { channel_slug: "geo", title: "Publish the page", body: { step: { body: "b", deliverable: { kind: "page", label: "Page copy", content } } } });
    render(<ChannelActionCard action={a} platform={platformFor("geo")} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: /^(Show|Read) more$/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "What it is" }));
    expect(screen.getByTestId("about-full-text").textContent).toContain("Line 30.");
  });

  it("··· has no Dismiss; the close icon drops the card", () => {
    const h = handlers();
    render(<ChannelActionCard action={FIXTURES.fix} platform={platformFor("blog")} handlers={h} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: /Dismiss/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("button", { name: /^Close “/ }));
    expect(h.onSetStatus).toHaveBeenCalledWith(FIXTURES.fix, "rejected", { keep: true });
  });

  it("PostCard: ··· holds Edit and Copy, and Edit opens the post editor", () => {
    render(<ChannelActionCard action={FIXTURES.text_post} platform={platformFor("x_organic")} handlers={handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(menuLabels()).toEqual(expect.arrayContaining(["Edit", "Copy"]));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Edit/ }));
    expect(screen.getByLabelText("Edit post")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});

describe("the top of the card", () => {
  it("the eyebrow carries the kind, Do this first as the chip, the New flag, and the first estimate as the big number", () => {
    const a = makeAction("pause_ad", {
      ...FIXTURES.pause_ad,
      id: "left-1",
      blocking: true,
      body: { ...FIXTURES.pause_ad.body, decision_evidence: { stats: [], estimate: [{ value: "$740/mo", caption: "back into the same campaign" }, { value: "+3", caption: "bookings" }] } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("google_ads")} handlers={handlers()} isNew />);
    const card = screen.getByTestId(`action-${a.id}`);
    const kind = within(card).getByTestId("action-kind");
    expect(kind.textContent).toBe("To do");
    const top = kind.parentElement as HTMLElement;
    expect(within(top).getByText("Do this first")).toBeTruthy();
    expect(top.textContent).not.toContain("· Blocking");
    expect(top.textContent).toContain("New");
    expect(within(card).queryByRole("button", { name: /^Show more$/ })).toBeNull();
    const about = openAbout(card);
    expect(about).toContain("$740/mo");
    expect(about).toContain("bookings");
  });
});

describe("the card's lists (codex review, 2026-09-23)", () => {
  it("a list header keeps only its last sentence, so the lead is not printed twice", () => {
    const a = makeAction("check", { channel_slug: "blog", title: "Set up tracking", body: { step: { body: "Tracking is broken on signup. Set up:\n- Pixel.\n- Conversions API.", effort: "hours" } } });
    render(<ChannelActionCard action={a} platform={platformFor("blog")} handlers={handlers()} />);
    const card = screen.getByTestId(`action-${a.id}`);
    const text = card.textContent ?? "";
    expect(text.split("Tracking is broken on signup.").length - 1).toBe(1);
    expect(openAbout(card)).toContain("Set up:");
  });

  it("a blank line between the header and its list does not drop the header", () => {
    const a = makeAction("check", { channel_slug: "blog", title: "Set up tracking", body: { step: { body: "Tracking is missing.\nSet up:\n\n- Pixel.\n- Conversions API.", effort: "hours" } } });
    render(<ChannelActionCard action={a} platform={platformFor("blog")} handlers={handlers()} />);
    const about = openAbout(screen.getByTestId(`action-${a.id}`));
    expect(about).toContain("Set up:");
    expect(about).toContain("Conversions API.");
  });

  it("a bulleted body list stays bullets, unnumbered, and never claims What Zavi will do", () => {
    const a = makeAction("check", { channel_slug: "google_ads", title: "Pause 2 keywords", body: { step: { body: "They spent with no conversions.\n- turo (BROAD): $177, 0 conv\n- apps like turo (BROAD): $13, 0 conv", effort: "hours" } } });
    render(<ChannelActionCard action={a} platform={platformFor("google_ads")} handlers={handlers()} />);
    const card = screen.getByTestId(`action-${a.id}`);
    expect([...card.querySelectorAll("ul > li")].map((li) => li.textContent)).toEqual(["turo (BROAD): $177, 0 conv", "apps like turo (BROAD): $13, 0 conv"]);
    expect(card.textContent).not.toContain("What Zavi will do");
    expect(card.textContent).not.toMatch(/1turo/);
  });
});

describe("whose steps the card names", () => {
  const body = { step: { body: "It spent $598 with no conversions.\n\nDuplicate the campaign. Attach the pixel.", effort: "hours" } };

  it("a card the founder carries out has no approve control and never says What Zavi will do", () => {
    const a = makeAction("check", { channel_slug: "meta_ads", title: "Rebuild the campaign", body });
    render(<ChannelActionCard action={a} platform={platformFor("meta_ads")} handlers={handlers()} />);
    const card = screen.getByTestId(`action-${a.id}`);
    expect(card.querySelector("button[data-approve]")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "How it works" }));
    expect(card.textContent).not.toContain("What Zavi will do");
  });

  it("a change Zavi applies itself has the approve control and never tells the founder to do it", () => {
    const a = makeAction("check", { channel_slug: "meta_ads", title: "Rebuild the campaign", body, executable: true });
    render(<ChannelActionCard action={a} platform={platformFor("meta_ads")} handlers={handlers()} />);
    const card = screen.getByTestId(`action-${a.id}`);
    expect(card.querySelector("button[data-approve]")).not.toBeNull();
    expect(card.textContent).not.toContain("You do it");
    fireEvent.click(within(card).getByRole("button", { name: "How it works" }));
    expect(card.textContent).toContain("Press Approve.");
  });
});

describe("the ··· menu on a short screen", () => {
  it("caps its height at the room it has and scrolls inside, without closing", () => {
    render(<ChannelActionCard action={FIXTURES.text_post} platform={platformFor("x_organic")} handlers={handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const menu = screen.getByRole("menu");
    expect(menu.style.maxHeight).not.toBe("");
    expect(menu.className).toContain("overflow-y-auto");
    fireEvent.scroll(menu);
    expect(screen.queryByRole("menu")).not.toBeNull();
    fireEvent.scroll(window);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("while editing a post", () => {
  it("the editor is a dialog, and Apply changes returns to the card with its primary intact", () => {
    render(<ChannelActionCard action={FIXTURES.text_post} platform={platformFor("x_organic")} handlers={handlers({ onPublish: vi.fn().mockResolvedValue(true) })} />);
    openEditor();
    expect(screen.getByLabelText("Edit post")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByLabelText("Edit post")).toBeNull();
    const card = screen.getByTestId(`action-${FIXTURES.text_post.id}`);
    expect(within(card).getByRole("button", { name: "Post on X" })).toBeTruthy();
  });
});

describe("a long post draft", () => {
  it("holds the complete post at rest and in the editor", () => {
    const content = "A sentence of the draft.\n".repeat(20);
    const long = makeAction("text_post", { channel_slug: "reddit_organic", body: { step: { deliverable: { kind: "post", content } } } });
    render(<ChannelActionCard action={long} platform={platformFor("reddit_organic")} handlers={handlers()} />);
    expect(screen.getByTestId("post-text").textContent?.split("A sentence of the draft.").length).toBe(21);
    openEditor();
    expect((screen.getByLabelText("Edit post") as HTMLTextAreaElement).value.split("A sentence of the draft.").length).toBe(21);
  });
});

describe("codex re-review, 2026-09-23", () => {
  it("two lists split by a blank line stay two lists, each numbered from its own start", () => {
    const a = makeAction("check", { channel_slug: "blog", title: "Two lists", body: { step: { body: "Pick one.\n- Option A\n- Option B\n\n1. Verify it\n2. Launch it", effort: "hours" } } });
    render(<ChannelActionCard action={a} platform={platformFor("blog")} handlers={handlers()} />);
    const about = openAbout(screen.getByTestId(`action-${a.id}`));
    expect(about).toContain("Option B");
    expect(about).toContain("Verify it");
    expect(about).toContain("Launch it");
    expect(document.querySelectorAll("dialog ol li").length).toBe(2);
  });
});

describe("the ··· menu never runs past the edge it opened toward", () => {
  it("on a short landscape screen it opens toward the roomier side and caps at that room", () => {
    const h = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { value: 390, configurable: true });
    render(<ChannelActionCard action={FIXTURES.text_post} platform={platformFor("x_organic")} handlers={handlers()} />);
    const btn = screen.getByRole("button", { name: "More actions" });
    btn.getBoundingClientRect = () => ({ top: 250, bottom: 286, left: 0, right: 40, width: 40, height: 36, x: 0, y: 250, toJSON: () => ({}) }) as DOMRect;
    fireEvent.click(btn);
    const menu = screen.getByRole("menu");
    expect(menu.style.bottom).not.toBe("");
    expect(parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(250 - 8 - 8);
    Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
  });
});
