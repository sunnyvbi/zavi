// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
const moveToHistory = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock("../card/useMoveToHistory", () => ({ useMoveToHistory: (options: unknown) => moveToHistory(options) }));
const ws = vi.hoisted(() => ({ role: null as string | null }));
vi.mock("../../WorkspaceShell", async (orig) => ({
  ...(await orig<typeof import("../../WorkspaceShell")>()),
  useWorkspaceOptional: () => (ws.role ? { role: ws.role } : null),
}));

import { ChannelActionCard } from "../ChannelActionCard";
import { clearBlankContextCache } from "../BlanksFill";
import { KeptCardsProvider } from "../card/keptCards";
import { platformFor } from "../platforms";
import type { ActionHandlers, ActionItem } from "../types";
import { makeAction } from "./fixtures";

const ok = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const fail = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
const routes = (map: Record<string, () => Promise<unknown>>) => apiFetch.mockImplementation((path: string) => (map[path] ? map[path]() : fail()));
const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clearBlankContextCache();
  apiFetch.mockReset();
  moveToHistory.mockReset();
  routes({});
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);

const handlers = (over: Partial<ActionHandlers> = {}): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onOpenChat: vi.fn(), ...over });

const DRAFT = "Subject: A spot for [first name]\nPreview: See you soon\n\nHi [first name],\n\nYour class is booked.\n\nSee [class: the one they chose] on the timetable.\n\nOne more line.";

const emailCard = (content = DRAFT, over: Partial<ActionItem> = {}) =>
  makeAction("send_message", {
    channel_slug: "email_marketing",
    title: "Welcome new members",
    body: { step: { title: "Email", body: "Why one. Why two. A third sentence that goes to Details.", deliverable: { kind: "email", label: "Email", content } } },
    card_kind: "message",
    primary_label: "Copy email",
    done_label: "I sent it",
    how_to: ["Press Copy email."],
    ...over,
  });

const mount = (a: ActionItem, h = handlers()) => {
  render(<KeptCardsProvider value={{ keep: vi.fn(), release: vi.fn() }}><ChannelActionCard action={a} platform={platformFor("email_marketing")} handlers={h} /></KeptCardsProvider>);
  return h;
};

const primary = () => document.querySelector("[data-primary]") as HTMLButtonElement;

describe("blanks sit inside the email box", () => {
  it("draws one muted count line and the fields inside the email, with no progress bar, then collapses to Blanks filled", async () => {
    mount(emailCard());
    await flush();
    const email = screen.getByTestId("email-box");
    const fill = screen.getByTestId("blanks-fill");
    expect(email.contains(fill)).toBe(true);
    expect(fill.className).toContain("border-t");
    expect(fill.className).not.toMatch(/\brounded/);
    expect(screen.queryByTestId("blanks-progress")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Fill these in first|of \d+ left/);
    expect(within(fill).getByTestId("blanks-left").textContent).toBe("2 blanks to fill");
    const grid = fill.querySelector("div.grid") as HTMLElement;
    expect(grid.className).toContain("sm:grid-cols-2");
    for (const input of Array.from(fill.querySelectorAll("input"))) expect(input.className).toContain("h-9");

    fireEvent.change(screen.getByLabelText("first name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText(/^class/), { target: { value: "Morning flow" } });
    expect(fill.dataset.state).toBe("filled");
    expect(within(fill).getByTestId("blanks-left").textContent).toBe("Blanks filled");
    expect(fill.querySelectorAll("input")).toHaveLength(0);
    fireEvent.click(within(fill).getByRole("button", { name: "Change" }));
    expect((screen.getByLabelText("first name") as HTMLInputElement).value).toBe("Ada");
    fireEvent.click(primary());
    await act(async () => {});
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toContain("See Morning flow on the timetable.");
  });

  it("keeps the fields open while the founder is still typing in them, even once every blank has a value", async () => {
    mount(emailCard());
    await flush();
    const fill = screen.getByTestId("blanks-fill");
    const first = screen.getByLabelText("first name");
    fireEvent.focus(first);
    fireEvent.change(screen.getByLabelText(/^class/), { target: { value: "Flow" } });
    fireEvent.change(first, { target: { value: "Ad" } });
    expect(fill.dataset.state).toBe("open");
    expect(screen.getByLabelText("first name")).toBe(first);
    fireEvent.blur(first, { relatedTarget: null });
    expect(fill.dataset.state).toBe("filled");
  });
});

describe("the Copy button", () => {
  it("is short with a count badge, while its accessible name still says how many blanks are left", async () => {
    mount(emailCard());
    await flush();
    const btn = primary();
    expect(btn.textContent).toBe("Copy email2 blanks");
    expect(btn.textContent).not.toContain("to fill");
    expect(within(btn).getByTestId("copy-blank-count").className).toContain("tabular-nums");
    expect(screen.getByRole("button", { name: "Copy email (2 blanks to fill)" })).toBe(btn);
    fireEvent.click(btn);
    await act(async () => {});
    expect(writeText).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText("first name"));
    fireEvent.change(screen.getByLabelText("first name"), { target: { value: "Ada" } });
    expect(screen.getByRole("button", { name: "Copy email (1 blank to fill)" }).textContent).toBe("Copy email1 blank");
    fireEvent.change(screen.getByLabelText(/^class/), { target: { value: "Flow" } });
    expect(screen.getByRole("button", { name: "Copy email" })).toBe(btn);
    expect(within(btn).queryByTestId("copy-blank-count")).toBeNull();
  });

  it("names the email number on a sequence", async () => {
    const parts = [
      { label: "Email 1: day 0", content: "Subject: Welcome [first name]\n\nHi there." },
      { label: "Email 2: day 3", content: "Subject: Still here\n\nHi again." },
    ];
    mount(emailCard(DRAFT, { body: { step: { title: "Seq", body: "b", deliverable: { kind: "email", label: "Seq", content: "x", parts } } } } as Partial<ActionItem>));
    await flush();
    expect(primary().textContent).toBe("Copy email 11 blank");
    expect(screen.getByRole("button", { name: "Copy email 1 (1 blank to fill)" })).toBe(primary());
  });
});

describe("How it works and What it is", () => {
  it("keeps the steps in a collapsed disclosure and the extra lines in the What it is dialog", async () => {
    mount(emailCard());
    await flush();
    expect(document.querySelector("details")).toBeNull();
    const toggle = screen.getByRole("button", { name: "How it works" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Press Copy email.")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!) as HTMLElement;
    expect(panel.textContent).toContain("Press Copy email.");
    fireEvent.click(screen.getByRole("button", { name: "What it is" }));
    expect(within(screen.getByRole("dialog", { name: "Details" })).getByText(/A third sentence that goes to Details\./)).toBeTruthy();
  });
});

describe("Reject and Redo live in More actions", () => {
  it("moves a finished card to History", async () => {
    const card = emailCard("Subject: Hi\n\nHello.");
    const h = mount(card);
    await flush();
    fireEvent.click(primary());
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "I sent it" }));
    await act(async () => {});
    expect(h.onSetStatus).toHaveBeenCalledWith(card, "acted", { keep: true });
    expect(moveToHistory).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }));
  });

  it("Reject asks for a note and posts a rejected status with it", async () => {
    const card = emailCard();
    const h = mount(card);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reject" }));
    fireEvent.change(screen.getByLabelText("Why are you rejecting it?"), { target: { value: "We never discount" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await act(async () => {});
    expect(h.onSetStatus).toHaveBeenCalledWith(card, "rejected", { note: "We never discount", hold: true, keep: true });
    expect(moveToHistory).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }));
    expect(h.onRedo).not.toHaveBeenCalled();
  });

  it("Redo sends the note to the redo handler", async () => {
    const card = emailCard();
    const h = mount(card);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Redo" }));
    fireEvent.change(screen.getByLabelText("What should Zavi do differently?"), { target: { value: "Shorter please" } });
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(h.onRedo).toHaveBeenCalledWith(card, "Shorter please");
    expect(h.onSetStatus).not.toHaveBeenCalled();
  });

  it("Edit opens the pinned chat when the page has one", async () => {
    const onOpenRedoChat = vi.fn();
    mount(emailCard(), handlers({ onOpenRedoChat }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onOpenRedoChat).toHaveBeenCalledTimes(1);
  });
});

describe("a multi-part card that is not an email", () => {
  it("shows a tab per part and copies the part on screen, with that part's blanks", async () => {
    const parts = [
      { label: "Post 1", content: "First post, no blanks." },
      { label: "Post 2", content: "Second post: read [link: the guide URL]." },
    ];
    mount(emailCard(DRAFT, { body: { step: { title: "Posts", body: "b", deliverable: { kind: "other", label: "Posts", content: "First post, no blanks.\n\nSecond post" , parts } } } } as Partial<ActionItem>));
    await flush();
    const box = screen.getByTestId("email-code-box");
    expect(box.querySelector("pre")?.textContent).toBe("First post, no blanks.");
    fireEvent.click(primary());
    await act(async () => {});
    expect(writeText).toHaveBeenLastCalledWith("First post, no blanks.");

    fireEvent.click(within(box).getByRole("tab", { name: "Post 2" }));
    expect(box.querySelector("pre")?.textContent).toBe("Second post: read [link: the guide URL].");
    expect(screen.getByRole("button", { name: "Copy part 2 (1 blank to fill)" })).toBe(primary());
    fireEvent.change(screen.getByLabelText("link: the guide URL"), { target: { value: "https://x.example/guide" } });
    fireEvent.click(primary());
    await act(async () => {});
    expect(writeText).toHaveBeenLastCalledWith("Second post: read https://x.example/guide.");
  });
});

describe("prefill and chips", () => {
  it("fills Your domain from the sending domain when company details have no website", async () => {
    routes({
      "/api/connectors/company-facts": () => ok({ facts: [{ key: "company_name", value_text: "Private Rents" }] }),
      "/api/workspace/sending-domain": () => ok({ domain: { domain: "private-rents.com", status: "verified" }, suggested_domain: null }),
    });
    mount(emailCard("Subject: Hi\n\nYou signed up at [your domain]."));
    await flush();
    expect(screen.getByTestId("blanks-fill").dataset.state).toBe("filled");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect((screen.getByLabelText("your domain") as HTMLInputElement).value).toBe("private-rents.com");
    expect(screen.getByTestId("blank-from").textContent).toBe("From Settings > Sending");
  });

  it("company website still wins over the sending domain, and the sending domain is not read then", async () => {
    routes({
      "/api/connectors/company-facts": () => ok({ facts: [{ key: "domain", value_text: "https://www.site.example" }] }),
      "/api/workspace/sending-domain": () => ok({ domain: { domain: "mail.other.example" } }),
    });
    mount(emailCard("Subject: Hi\n\nYou signed up at [your domain]."));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect((screen.getByLabelText("your domain") as HTMLInputElement).value).toBe("site.example");
    expect(apiFetch.mock.calls.map((c) => c[0])).not.toContain("/api/workspace/sending-domain");
  });

  it("names Improve results in the muted eyebrow, not a brand-blue chip", async () => {
    mount(makeAction("check", { channel_slug: "email_marketing", title: "Tighten the subject line", card_kind: "message", done_label: "I reviewed it", body: { step: { title: "t", body: "b" } } }));
    await flush();
    const eyebrow = screen.getByTestId("action-kind").parentElement as HTMLElement;
    expect(eyebrow.textContent).toContain("Improve results");
    expect(eyebrow.className).toContain("text-ca-secondary");
    expect(eyebrow.outerHTML).not.toContain("brand");
    expect(screen.getByRole("button", { name: "I reviewed it" }).hasAttribute("data-done")).toBe(true);
  });
});

describe("the work card is chosen by the platform row, not the channel slug", () => {
  it("an email_marketing row with no platform row renders the ordinary body", () => {
    render(<ChannelActionCard action={emailCard()} handlers={handlers()} />);
    expect(document.querySelector("[data-email-work-card]")).toBeNull();
    expect(screen.queryByTestId("email-card-actions")).toBeNull();
  });

  it("a row on another channel renders the work card when its platform row asks for it", () => {
    render(<ChannelActionCard action={emailCard(DRAFT, { channel_slug: "sms" })} platform={{ ...platformFor("sms"), workCard: true }} handlers={handlers()} />);
    expect(document.querySelector("[data-email-work-card='true']")).not.toBeNull();
    expect(screen.getByTestId("email-box")).toBeTruthy();
  });

  it("an email_marketing row on a platform row without workCard renders the ordinary body", () => {
    render(<ChannelActionCard action={emailCard()} platform={{ ...platformFor("email_marketing"), workCard: undefined }} handlers={handlers()} />);
    expect(document.querySelector("[data-email-work-card]")).toBeNull();
  });

  it("the email_marketing row asks for the work card", () => {
    expect(platformFor("email_marketing").workCard).toBe(true);
    mount(emailCard());
    expect(document.querySelector("[data-email-work-card='true']")).not.toBeNull();
  });
});

describe("an email Zavi could not stage for lack of a list", () => {
  it("leads with Make the list from your database, which opens Settings at Contacts with the database import asked for", async () => {
    const nav = await import("../../email/emailSettingsNav");
    const events: string[] = [];
    const listen = (e: Event) => events.push(e.type);
    window.addEventListener(nav.EMAIL_SETTINGS_GOTO_EVENT, listen);
    window.addEventListener(nav.OPEN_DATABASE_IMPORT_EVENT, listen);
    ws.role = "owner";
    mount(emailCard(DRAFT, { needs_contact_list: true }));
    await flush();
    const make = screen.getByTestId("email-make-list");
    expect(make.textContent).toBe("Make the list from your database");
    fireEvent.click(make);
    expect(events).toEqual([nav.EMAIL_SETTINGS_GOTO_EVENT, nav.OPEN_DATABASE_IMPORT_EVENT]);
    expect(nav.takeDatabaseImportRequest()).toBe(true);
    expect(nav.takeDatabaseImportRequest()).toBe(false);
    window.removeEventListener(nav.EMAIL_SETTINGS_GOTO_EVENT, listen);
    window.removeEventListener(nav.OPEN_DATABASE_IMPORT_EVENT, listen);
    ws.role = null;
  });

  it("is not offered to a member, who cannot import", async () => {
    ws.role = "member";
    mount(emailCard(DRAFT, { needs_contact_list: true }));
    await flush();
    expect(screen.queryByTestId("email-make-list")).toBeNull();
    ws.role = null;
  });

  it("a request is good only for the tab switch it started", async () => {
    const nav = await import("../../email/emailSettingsNav");
    vi.useFakeTimers();
    try {
      nav.requestDatabaseImport();
      vi.advanceTimersByTime(11_000);
      expect(nav.takeDatabaseImportRequest()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is not offered when the workspace can already send", async () => {
    mount(emailCard());
    await flush();
    expect(screen.queryByTestId("email-make-list")).toBeNull();
  });
});
