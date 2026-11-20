// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { ChannelActionCard } from "../ChannelActionCard";
import { deliverableParts } from "../types";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";
import { platformFor } from "../platforms";

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

const PARTS = [
  { label: "Headline A", content: "Plan your week in five minutes." },
  { label: "Headline B", content: "The five-minute weekly plan." },
];
const joined = PARTS.map((p) => `${p.label}\n${p.content}`).join("\n\n");

const post = (): ChannelActionView =>
  makeAction("text_post", {
    channel_slug: "made_up_social",
    title: "Post one of two headlines",
    body: { step: { body: "Short headlines get the most replies here.", deliverable: { kind: "post", label: "Post", content: joined, parts: PARTS } } },
  });

const copyCard = (): ChannelActionView =>
  makeAction("fix", {
    channel_slug: "made_up_site",
    title: "Replace the page headline",
    card_kind: "copy_to_site",
    primary_label: "Copy new text",
    done_label: "I updated the page",
    body: { step: { body: "The headline does not say what the product does.", deliverable: { kind: "copy", label: "Headline", content: joined, parts: PARTS } } },
  });

describe("deliverableParts", () => {
  it("needs two parts that carry text; one part is a single deliverable", () => {
    expect(deliverableParts(post())?.map((p) => p.label)).toEqual(["Headline A", "Headline B"]);
    const one = makeAction("text_post", { body: { step: { deliverable: { kind: "post", content: "x", parts: [PARTS[0], { label: "Empty", content: " " }] } } } });
    expect(deliverableParts(one)).toBeNull();
  });
});

describe("a post with parts", () => {
  it("shows one part at a time as tabs", () => {
    render(<ChannelActionCard action={post()} handlers={handlers()} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Headline A", "Headline B"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    const preview = screen.getByTestId("post-text");
    expect(preview.textContent).toBe(PARTS[0].content);
    expect(preview.textContent).not.toContain(PARTS[1].content);
    fireEvent.click(tabs[1]);
    expect(screen.getByTestId("post-text").textContent).toBe(PARTS[1].content);
  });

  it("Post publishes ONLY the part on screen, never every variant as one post", async () => {
    const onPublish = vi.fn().mockResolvedValue(true);
    render(<ChannelActionCard action={post()} handlers={handlers({ onPublish })} />);
    fireEvent.click(screen.getByRole("button", { name: /^Post on / }));
    await waitFor(() => expect(onPublish).toHaveBeenCalledTimes(1));
    expect(onPublish.mock.calls[0][1]).toEqual({ text: PARTS[0].content, thread: null });
    expect(onPublish.mock.calls[0][1].text).not.toContain(PARTS[1].content);
  });

  it("after switching tabs, Post publishes the newly selected part", async () => {
    const onPublish = vi.fn().mockResolvedValue(true);
    render(<ChannelActionCard action={post()} handlers={handlers({ onPublish })} />);
    fireEvent.click(screen.getAllByRole("tab")[1]);
    fireEvent.click(screen.getByRole("button", { name: /^Post on / }));
    await waitFor(() => expect(onPublish).toHaveBeenCalledTimes(1));
    expect(onPublish.mock.calls[0][1]).toEqual({ text: PARTS[1].content, thread: null });
  });

  it("an edit to one part survives switching tabs", () => {
    render(<ChannelActionCard action={post()} handlers={handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "Edited A." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getAllByRole("tab")[1]);
    expect(screen.getByTestId("post-text").textContent).toBe(PARTS[1].content);
    fireEvent.click(screen.getAllByRole("tab")[0]);
    expect(screen.getByTestId("post-text").textContent).toBe("Edited A.");
  });

  it("the part's own Copy takes that part; Copy all in the menu takes every part", async () => {
    render(<ChannelActionCard action={post()} handlers={handlers()} />);
    const tabs = screen.getByTestId("part-tabs");
    fireEvent.click(within(tabs).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(PARTS[0].content));
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy all/ }));
    expect(writeText).toHaveBeenLastCalledWith(joined);
  });
});

describe("Copy all copies exactly what the tabs show", () => {
  it("builds from the parts even when content says something else", () => {
    const a = makeAction("fix", {
      title: "Replace the page headline",
      card_kind: "copy_to_site",
      primary_label: "Copy new text",
      done_label: "I updated the page",
      body: { step: { body: "b", deliverable: { kind: "copy", label: "Headline", content: "One preferred headline.", parts: PARTS } } },
    });
    render(<ChannelActionCard action={a} handlers={handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy all/ }));
    expect(writeText).toHaveBeenLastCalledWith(joined);
  });

  it("a post's Copy all carries an edit made to one part", () => {
    render(<ChannelActionCard action={post()} handlers={handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "Edited A." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy all/ }));
    expect(writeText).toHaveBeenLastCalledWith(`Headline A\nEdited A.\n\nHeadline B\n${PARTS[1].content}`);
  });
});

describe("a copy card with parts", () => {
  it("an Instagram bio copies the selected alternative without publishing or marking it done", async () => {
    const bios = [
      { label: "Bio A", content: "Handmade cups for your daily coffee. Shop the collection." },
      { label: "Bio B", content: "Make your coffee ritual yours. Explore handmade cups." },
      { label: "Bio C", content: "A handmade cup for every morning. Find your favourite." },
    ];
    const h = handlers({ onPublish: vi.fn() });
    render(<ChannelActionCard action={makeAction("fix", {
      channel_slug: "instagram_organic", title: "Choose your Instagram bio",
      card_kind: "copy_to_site", primary_label: "Copy new text", done_label: "I updated the page",
      how_to: ["Copy one bio and update your Instagram profile."],
      body: { step: { body: "Choose one of three bios.", deliverable: { kind: "page_copy", label: "Instagram bios", content: bios[0].content, parts: bios } } },
    })} handlers={h} />);
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    fireEvent.click(screen.getByRole("tab", { name: "Bio B" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy new text" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(bios[1].content));
    expect(h.onSetStatus).not.toHaveBeenCalled();
    expect(h.onApprove).not.toHaveBeenCalled();
    expect(h.onPublish).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "I updated the page" })).toBeTruthy();
  });

  it("shows the selected part; the footer's Copy takes it, Copy all takes every part", () => {
    render(<ChannelActionCard action={copyCard()} handlers={handlers()} />);
    const card = screen.getByRole("article");
    expect(card.textContent).toContain(PARTS[0].content);
    expect(card.textContent).not.toContain(PARTS[1].content);
    fireEvent.click(screen.getAllByRole("tab")[1]);
    expect(screen.getByRole("article").textContent).toContain(PARTS[1].content);

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Copy(?! all)/ }));
    expect(writeText).toHaveBeenLastCalledWith(PARTS[1].content);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy all/ }));
    expect(writeText).toHaveBeenLastCalledWith(joined);
  });

  it("a single deliverable draws no tabs and no Copy all", () => {
    const a = makeAction("fix", { body: { step: { body: "b", deliverable: { kind: "copy", label: "Headline", content: "One headline." } } } });
    render(<ChannelActionCard action={a} handlers={handlers()} />);
    expect(screen.queryByRole("tablist")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: /Copy all/ })).toBeNull();
  });
});

describe("a three-email sequence in the card's right side", () => {
  const EMAILS = [
    { label: "Email 1: now", content: "Subject: You're on the list\n\nHi [first name]," },
    { label: "Email 2: day 3", content: "Subject: Your first class\n\nHi again," },
    { label: "Email 3: day 7", content: "Subject: How was it?\n\nOne week in," },
  ];
  const sequence = (): ChannelActionView =>
    makeAction("send_message", {
      channel_slug: "email_marketing",
      title: "Paste the 3-email welcome sequence into your email tool",
      body: {
        step: {
          body: "Email 1 goes out on signup, Email 2 on day 3, Email 3 on day 7.",
          deliverable: {
            kind: "message",
            label: "Welcome sequence for new sign-ups",
            content: EMAILS.map((p) => `${p.label}\n${p.content}`).join("\n\n"),
            parts: EMAILS,
          },
        },
      },
    });

  it("tabs the sequence: each tab shows that email's subject, and Copy names and copies the email on screen", async () => {
    render(<ChannelActionCard action={sequence()} platform={platformFor("email_marketing")} handlers={handlers()} />);
    const box = screen.getByTestId("email-box");
    const tabs = within(box).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Email 1Now", "Email 2Day 3", "Email 3Day 7"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(within(box).getByTestId("email-box-subject").textContent).toBe("You're on the list");
    expect(within(box).getAllByTestId("email-slot").map((m) => m.textContent)).toEqual(["[first name]"]);
    expect(box.textContent?.match(/Subject:/g)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Copy email 1 (1 blank to fill)" })).toBeTruthy();

    fireEvent.click(tabs[2]);
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].getAttribute("aria-selected")).toBe("false");
    expect(within(box).getByTestId("email-box-subject").textContent).toBe("How was it?");
    expect(screen.queryByRole("button", { name: /^Copy email 1/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy email 3" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(EMAILS[2].content);

    fireEvent.click(tabs[1]);
    expect(within(box).getByTestId("email-box-subject").textContent).toBe("Your first class");
    fireEvent.click(screen.getByRole("button", { name: "Copy email 2" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenLastCalledWith(EMAILS[1].content);
    expect(screen.queryByTestId("part-tabs")).toBeNull();
  });

  it("an email channel draft is the email work card, and a single email has no tabs", () => {
    const { unmount } = render(<ChannelActionCard action={sequence()} platform={platformFor("email_marketing")} handlers={handlers()} />);
    const card = screen.getByTestId("email-box").closest<HTMLElement>("[data-email-work-card]")!;
    expect(card.dataset.emailWorkCard).toBe("true");
    unmount();
    const single = sequence();
    single.body!.step!.deliverable = { kind: "email", label: "One email", content: EMAILS[2].content };
    render(<ChannelActionCard action={single} platform={platformFor("email_marketing")} handlers={handlers()} />);
    expect(within(screen.getByTestId("email-box")).queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByTestId("email-box-subject").textContent).toBe("How was it?");
  });
});
