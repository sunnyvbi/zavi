// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { ChannelActionCard } from "../ChannelActionCard";
import { ChannelSurface } from "../ChannelSurface";
import { clearBlankContextCache } from "../BlanksFill";
import { EMAIL_FOOTER_SAVED_EVENT } from "@/lib/workspace/emailCampaignSettingsApi";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";

const SETTINGS = "/api/channels/email_marketing/settings";
const TEMPLATE = "/api/workspace/email-template";
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

let fields: Record<string, unknown>;
let template: unknown;
let settingsDown: boolean;
const puts: Array<{ path: string; items: string[] }> = [];
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fields = {};
  template = null;
  settingsDown = false;
  clearBlankContextCache();
  apiFetch.mockReset();
  puts.length = 0;
  apiFetch.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PUT") {
      const field = decodeURIComponent(path.split("/").pop() ?? "");
      const items = (JSON.parse(init.body ?? "{}").items ?? []) as string[];
      puts.push({ path, items });
      fields = { ...fields, [field]: items.map((item) => ({ item })) };
      return json({});
    }
    if (path === SETTINGS) return settingsDown ? json({}, 500) : json({ fields });
    if (path === TEMPLATE) return json({ template, fonts: [], can_edit: true });
    return json({}, 404);
  });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  Element.prototype.scrollIntoView = function () {};
});
afterEach(cleanup);

const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onOpenChat: vi.fn() });
const seq = (...bodies: string[]) =>
  makeAction("send_message", {
    channel_slug: "email_marketing",
    title: "Load the 3-email welcome sequence into SendGrid for new accounts",
    body: {
      step: {
        title: "Seq",
        body: "Why.",
        deliverable: {
          kind: "email",
          label: "Seq",
          content: "x",
          parts: [...bodies, ...(bodies.length < 2 ? ["Bye."] : [])].map((b, n) => ({ label: `Email ${n + 1}: day ${n}`, content: `Subject: Welcome\n\nHi there,\n\nGlad you joined.\n\n${b}` })),
        },
      },
    },
    card_kind: "message",
    primary_label: "Copy email",
  });
const mount = async (a = seq("[unsubscribe link]", "[unsubscribe link]", "[unsubscribe link]")) => {
  render(<ChannelSurface slug="email_marketing"><ChannelActionCard action={a} platform={platformFor("email_marketing")} handlers={handlers()} /></ChannelSurface>);
  await flush();
};
const copy = () => screen.getByRole("button", { name: /^Copy email/ }) as HTMLButtonElement;
const slot = () => screen.getByTestId("footer-slot");
const text = () => document.body.textContent ?? "";

describe("copy-and-send card whose only blank is a footer blank", () => {
  it("shows the blank in the email, offers Add instead of a greyed Copy, and drops every blank-count line", async () => {
    await mount();
    expect(slot().dataset.state).toBe("missing");
    expect(slot().textContent).toContain("Unsubscribe link missing");
    expect(slot().textContent).toContain("Emails need this before they can go out.");
    expect(within(screen.getByTestId("email-box")).getByTestId("footer-slot")).toBe(slot());
    expect(screen.getByRole("button", { name: "Add unsubscribe link" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Copy email/ })).toBeNull();
    expect(screen.queryByTestId("copy-blank-count")).toBeNull();
    expect(screen.queryByTestId("blanks-left")).toBeNull();
    expect(screen.queryByTestId("blank-footer-missing")).toBeNull();
    expect(text()).not.toContain("to fill");
    expect(text()).not.toContain("blank in the email above");
    expect(text()).not.toContain("Footer from");
    expect(text()).not.toContain("Open Footer settings");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("uses postal address wording, and plain words for both", async () => {
    await mount(seq("[postal address]"));
    expect(slot().textContent).toContain("Postal address missing");
    expect(screen.getByRole("button", { name: "Add postal address" })).toBeTruthy();
    cleanup();
    clearBlankContextCache();
    await mount(seq("[postal address]\n\n[unsubscribe link]"));
    expect(slot().textContent).toContain("Postal address and unsubscribe link missing");
    expect(slot().textContent).toContain("Emails need these before they can go out.");
    expect(screen.getByRole("button", { name: "Add footer details" })).toBeTruthy();
  });

  it("with a typed blank too, keeps its input, reads Fill 2 items, and jumps to the typed input with a truthful hint", async () => {
    await mount(seq("[unsubscribe link]\n\nHi [first name]"));
    const btn = screen.getByRole("button", { name: "Fill 2 items" });
    expect(btn.textContent).toBe("Fill 2 items");
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("blanks-left").textContent).toBe("1 blank to fill");
    expect(screen.queryByTestId("copy-blank-count")).toBeNull();
    fireEvent.click(btn);
    await flush();
    expect(writeText).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText("first name"));
    expect(text()).toContain("Fill the 1 blank in the email above and add your unsubscribe link in Settings > Footer, then press Copy email 1 again.");
    fireEvent.change(screen.getByLabelText("first name"), { target: { value: "Ada" } });
    await flush();
    expect(screen.getByRole("button", { name: "Add unsubscribe link" })).toBeTruthy();
    expect(text()).not.toContain("blank in the email above");
  });

  it("claims nothing is missing while the footer settings cannot be read", async () => {
    settingsDown = true;
    await mount();
    expect(screen.queryByTestId("footer-slot")).toBeNull();
    expect(screen.queryByRole("button", { name: /Add unsubscribe link/ })).toBeNull();
    expect(screen.getByTestId("blank-footer-unread").textContent).toBe("Could not read your footer settings. Trying again.");
    expect(text()).not.toContain("missing");
    fireEvent.click(copy());
    await flush();
    expect(writeText).not.toHaveBeenCalled();
    expect(text()).not.toContain("Add your unsubscribe link");
  });

  it("Add and Edit go to Settings > Footer on the Email campaigns page, with no popup", async () => {
    const goto = vi.fn();
    window.addEventListener("zavi:email-settings-goto", goto);
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Add unsubscribe link" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(goto).toHaveBeenCalledTimes(1);
    expect((goto.mock.calls[0]![0] as CustomEvent).detail).toEqual({ section: "footer" });
    cleanup();
    fields = { unsubscribe_link: [{ item: "https://northside.example/unsubscribe" }] };
    clearBlankContextCache();
    await mount();
    fireEvent.click(within(slot()).getByRole("button", { name: "Edit" }));
    expect(goto).toHaveBeenCalledTimes(2);
    window.removeEventListener("zavi:email-settings-goto", goto);
  });

  it("a card opened again after the footer was saved while it was away shows the footer and Copy, inside the cache window", async () => {
    await mount();
    expect(screen.getByRole("button", { name: "Add unsubscribe link" })).toBeTruthy();
    cleanup();
    fields = { unsubscribe_link: [{ item: "https://northside.example/unsubscribe" }] };
    window.dispatchEvent(new Event(EMAIL_FOOTER_SAVED_EVENT));
    await mount();
    expect(slot().dataset.state).toBe("filled");
    expect(slot().textContent).toContain("https://northside.example/unsubscribe");
    expect(copy().textContent).toBe("Copy email 1");
    fireEvent.click(copy());
    await flush();
    expect(writeText.mock.calls[0][0]).toContain("https://northside.example/unsubscribe");
  });

  it("updates and unblocks Copy when the footer is saved elsewhere", async () => {
    await mount();
    expect(screen.queryByRole("button", { name: /^Copy email/ })).toBeNull();
    fields = { unsubscribe_link: [{ item: "https://northside.example/unsubscribe" }] };
    await act(async () => {
      window.dispatchEvent(new Event(EMAIL_FOOTER_SAVED_EVENT));
    });
    await flush();
    expect(slot().dataset.state).toBe("filled");
    expect(copy().textContent).toBe("Copy email 1");
    expect(screen.queryByRole("button", { name: "Add unsubscribe link" })).toBeNull();
    fireEvent.click(copy());
    await flush();
    expect(writeText.mock.calls[0][0]).toContain("https://northside.example/unsubscribe");
  });
});

describe("a tool that adds the unsubscribe link", () => {
  it("SendGrid, known from the pinned sender, needs no Zavi link: Copy works and the clipboard holds the tool's tag, no placeholder", async () => {
    fields = { sendgrid_sender_id: [{ item: "sender-1" }] };
    await mount(seq("Unsubscribe: [your email tool's unsubscribe link]"));
    expect(screen.queryByTestId("footer-slot")?.dataset.state).not.toBe("missing");
    expect(screen.queryByRole("button", { name: /Add unsubscribe link/ })).toBeNull();
    expect(copy().textContent).toBe("Copy email 1");
    expect(slot().textContent).toContain("SendGrid");
    fireEvent.click(copy());
    await flush();
    const out = writeText.mock.calls[0][0] as string;
    expect(out).toContain("Unsubscribe: {{{unsubscribe}}}");
    expect(out).not.toMatch(/\[[^\]]*unsubscribe/i);
    expect(out).not.toMatch(/Unsubscribe:\s*$/m);
  });

  it("a legacy Mailchimp setting is honoured the same way", async () => {
    fields = { esp: [{ item: "mailchimp" }] };
    await mount(seq("Unsubscribe: [unsubscribe link]"));
    fireEvent.click(copy());
    await flush();
    expect(writeText.mock.calls[0][0]).toContain("Unsubscribe: *|UNSUB|*");
  });

  it("with no tool on the account (Gmail or plain copy) the block stays", async () => {
    fields = { sendgrid_sender_id: [] };
    await mount(seq("Unsubscribe: [unsubscribe link]"));
    expect(slot().dataset.state).toBe("missing");
    expect(screen.queryByRole("button", { name: /^Copy email/ })).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("typed blanks and long emails", () => {
  it("keeps today's button, chip and hint for a typed blank alone", async () => {
    await mount(seq("Hi [first name]"));
    expect(screen.getByRole("button", { name: "Copy email 1 (1 blank to fill)" })).toBe(copy());
    expect(copy().textContent).toBe("Copy email 11 blank");
    fireEvent.click(copy());
    await flush();
    expect(text()).toContain("Fill the 1 blank in the email above, then press Copy email 1 again.");
  });

  it("shows two paragraphs, then Read more opens the rest and Show less folds it again", async () => {
    await mount(seq("One.\n\nTwo.\n\nThree.\n\nFour.", "Two"));
    expect(text()).not.toContain("Three.");
    fireEvent.click(screen.getByRole("button", { name: "Read more" }));
    expect(text()).toContain("Four.");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(text()).not.toContain("Three.");
  });
});
