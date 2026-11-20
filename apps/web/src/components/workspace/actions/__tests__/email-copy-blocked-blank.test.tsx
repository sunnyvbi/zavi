// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { ChannelActionCard } from "../ChannelActionCard";
import { clearBlankContextCache } from "../BlanksFill";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

let writeText: ReturnType<typeof vi.fn>;
let scrolled: HTMLElement[];
beforeEach(() => {
  clearBlankContextCache();
  apiFetch.mockReset();
  apiFetch.mockImplementation(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled.push(this);
  };
});
afterEach(cleanup);

const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onOpenChat: vi.fn() });
const DRAFT = "Subject: A spot for you\nPreview: See you soon\n\nHi [first name],\n\nYour class is booked.\n\nOne more line.";
const card = () =>
  makeAction("send_message", {
    channel_slug: "email_marketing",
    title: "Welcome new members",
    body: { step: { title: "Email", body: "Why one.", deliverable: { kind: "email", label: "Email", content: DRAFT } } },
    card_kind: "message",
    primary_label: "Copy email",
    done_label: "I sent it",
  });
const primary = () => screen.getByRole("button", { name: /^Copy email/ }) as HTMLButtonElement;

describe("Copy email with an unfilled blank", () => {
  it("looks disabled while a blank is empty", async () => {
    render(<ChannelActionCard action={card()} platform={platformFor("email_marketing")} handlers={handlers()} />);
    await flush();
    expect(primary().className.split(/\s+/).some((c) => c === "opacity-50" || c.startsWith("aria-disabled:"))).toBe(true);
  });

  it("does not copy, leads to the blank, and copies once it is filled", async () => {
    render(<ChannelActionCard action={card()} platform={platformFor("email_marketing")} handlers={handlers()} />);
    await flush();
    const btn = primary();
    expect(btn.getAttribute("aria-label")).toBe("Copy email (1 blank to fill)");
    expect(btn.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(btn);
    await flush();
    expect(writeText).not.toHaveBeenCalled();
    const input = screen.getByRole("textbox", { name: "first name" });
    expect(document.activeElement).toBe(input);
    expect(scrolled).toContain(input);
    expect(screen.getByRole("status").textContent).toContain("Fill the 1 blank");

    fireEvent.change(input, { target: { value: "Sam" } });
    await flush();
    const ready = screen.getByRole("button", { name: "Copy email" });
    expect(ready.getAttribute("aria-disabled")).toBeNull();
    expect(ready.className.split(/\s+/)).toEqual(expect.arrayContaining(["bg-ca-action", "text-ca-on-action", "hover:bg-ca-action-hover"]));
    fireEvent.click(ready);
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("Hi Sam,");
    expect(writeText.mock.calls[0][0]).not.toContain("[first name]");
  });

  it("keyboard activation of the blocked button also leads to the blank", async () => {
    render(<ChannelActionCard action={card()} platform={platformFor("email_marketing")} handlers={handlers()} />);
    await flush();
    const btn = primary();
    btn.focus();
    fireEvent.keyDown(btn, { key: "Enter" });
    fireEvent.click(btn);
    await flush();
    expect(writeText).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "first name" }));
  });

  it("with only a footer blank there is no input and no Copy: the Add button opens the footer form", async () => {
    apiFetch.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/api/workspace/email-template"
          ? { ok: true, json: () => Promise.resolve({ template: { postal_address: "" }, fonts: [], can_edit: true }) }
          : path === "/api/connectors/company-facts"
            ? { ok: true, json: () => Promise.resolve({ facts: [] }) }
            : path === "/api/channels/email_marketing/settings"
              ? { ok: true, json: () => Promise.resolve({ fields: { esp: [{ item: "mailchimp" }] } }) }
              : { ok: false, json: () => Promise.resolve({}) },
      ),
    );
    const content = "Subject: A spot for you\nPreview: See you soon\n\nHi there,\n\nYour class is booked.\n\n[Postal address: required by US law on every marketing email]";
    const a = makeAction("send_message", {
      channel_slug: "email_marketing",
      title: "Welcome new members",
      body: { step: { title: "Email", body: "Why one.", deliverable: { kind: "email", label: "Email", content } } },
      card_kind: "message",
      primary_label: "Copy email",
      done_label: "I sent it",
    });
    render(<ChannelActionCard action={a} platform={platformFor("email_marketing")} handlers={handlers()} />);
    await flush();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Copy email/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add postal address" }));
    await flush();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

const LINK = "[link: your menu page, tracked]";
const linkCard = (content: string) =>
  makeAction("send_message", {
    channel_slug: "email_marketing",
    title: "Menu email",
    body: { step: { title: "Email", body: "Why one.", deliverable: { kind: "email", label: "Email", content } } },
    card_kind: "message",
    primary_label: "Copy email",
    done_label: "I sent it",
  });
const LINK_DRAFT = `Subject: The menu\nPreview: Fresh this week\n\nHi there,\n\nSee the menu -> ${LINK}\n\nOne more line.`;
const TWO_DRAFT = `Subject: The menu\nPreview: Fresh this week\n\nHi [first name],\n\nSee the menu -> ${LINK}\n\nOne more line.`;
const linkBox = () => screen.getByRole("textbox", { name: "link: your menu page, tracked" }) as HTMLInputElement;
const type = async (el: HTMLElement, value: string) => {
  fireEvent.change(el, { target: { value } });
  await flush();
};

describe("a link blank needs a valid https link", () => {
  const mount = async (content = LINK_DRAFT) => {
    render(<ChannelActionCard action={linkCard(content)} platform={platformFor("email_marketing")} handlers={handlers()} />);
    await flush();
  };

  it("'not a url' keeps Copy blocked, says what is needed, and never reaches the clipboard", async () => {
    await mount();
    await type(linkBox(), "not a url");
    fireEvent.blur(linkBox());
    await flush();
    const btn = primary();
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe("Copy email (1 blank to fill)");
    expect(screen.getByTestId("blank-problem").textContent).toBe("Enter a full link that starts with https://");
    expect(linkBox().getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(btn);
    await flush();
    expect(writeText).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(linkBox());
  });

  it("rejects http:// and a host without a dot", async () => {
    await mount();
    for (const bad of ["http://x", "http://example.com/menu", "https://localhost", "javascript:alert(1)", "example.com/menu"]) {
      await type(linkBox(), bad);
      expect(primary().getAttribute("aria-disabled"), bad).toBe("true");
      expect(screen.getByTestId("blank-problem"), bad).toBeTruthy();
      fireEvent.click(primary());
      await flush();
    }
    expect(writeText).not.toHaveBeenCalled();
  });

  it("a valid https link enables Copy and lands in the clipboard text", async () => {
    await mount();
    await type(linkBox(), "https://shop.example.com/menu?utm=a");
    expect(screen.queryByTestId("blank-problem")).toBeNull();
    const ready = screen.getByRole("button", { name: "Copy email" });
    expect(ready.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(ready);
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("See the menu -> https://shop.example.com/menu?utm=a");
    expect(writeText.mock.calls[0][0]).not.toContain("[link");
  });

  it("trims spaces around a pasted valid link", async () => {
    await mount();
    await type(linkBox(), "   https://shop.example.com/menu  \n");
    expect(screen.queryByTestId("blank-problem")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy email" }));
    await flush();
    expect(writeText.mock.calls[0][0]).toContain("See the menu -> https://shop.example.com/menu\n");
    expect(writeText.mock.calls[0][0]).not.toContain("-> ht".concat("tps://shop.example.com/menu "));
  });

  it("going from a valid link back to junk blocks Copy again", async () => {
    await mount();
    await type(linkBox(), "https://shop.example.com/menu");
    expect(primary().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await flush();
    await type(linkBox(), "https://shop.example.com/menu and more");
    expect(primary().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(primary());
    await flush();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("a text blank still takes free text", async () => {
    await mount(`Subject: A\nPreview: B\n\nHi [first name], welcome.\n\nSee you.`);
    const box = screen.getByRole("textbox", { name: "first name" });
    await type(box, "not a url at all");
    expect(screen.queryByTestId("blank-problem")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy email" }));
    await flush();
    expect(writeText.mock.calls[0][0]).toContain("Hi not a url at all,");
  });
});

describe("the blocked-Copy line follows the blanks", () => {
  const mount = async () => {
    render(<ChannelActionCard action={linkCard(TWO_DRAFT)} platform={platformFor("email_marketing")} handlers={handlers()} />);
    await flush();
  };

  it("clears as soon as the only blank is filled, without another click", async () => {
    render(<ChannelActionCard action={linkCard(LINK_DRAFT)} platform={platformFor("email_marketing")} handlers={handlers()} />);
    await flush();
    fireEvent.click(primary());
    await flush();
    expect(screen.getByRole("status").textContent).toContain("Fill the 1 blank");
    await type(linkBox(), "https://shop.example.com/menu");
    expect(screen.queryByRole("status")).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("an invalid link does not clear the line", async () => {
    render(<ChannelActionCard action={linkCard(LINK_DRAFT)} platform={platformFor("email_marketing")} handlers={handlers()} />);
    await flush();
    fireEvent.click(primary());
    await flush();
    await type(linkBox(), "not a url");
    expect(screen.getByRole("status").textContent).toContain("Fill the 1 blank");
  });

  it("with 2 blanks, filling one updates the count to 1, filling both clears it", async () => {
    await mount();
    fireEvent.click(primary());
    await flush();
    expect(screen.getByRole("status").textContent).toContain("Fill the 2 blanks");
    await type(screen.getByRole("textbox", { name: "first name" }), "Sam");
    expect(screen.getByRole("status").textContent).toContain("Fill the 1 blank in");
    expect(screen.getByRole("status").textContent).not.toContain("2 blanks");
    await type(linkBox(), "https://shop.example.com/menu");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not come back when a filled blank is emptied again", async () => {
    await mount();
    fireEvent.click(primary());
    await flush();
    await type(screen.getByRole("textbox", { name: "first name" }), "Sam");
    await type(linkBox(), "https://shop.example.com/menu");
    const change = screen.queryByRole("button", { name: "Change" });
    if (change) fireEvent.click(change);
    await flush();
    await type(screen.getByRole("textbox", { name: "first name" }), "");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
