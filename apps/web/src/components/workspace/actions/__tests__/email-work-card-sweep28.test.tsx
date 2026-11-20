// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { ChannelActionCard } from "../ChannelActionCard";
import { clearBlankContextCache } from "../BlanksFill";
import { ESP_TAGS, isUnsubscribeLink, LINK_PROBLEM, linkProblem } from "../blanks";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clearBlankContextCache();
  apiFetch.mockReset();
  apiFetch.mockImplementation(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  Element.prototype.scrollIntoView = function () {};
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
const mount = async () => {
  render(<ChannelActionCard action={card()} platform={platformFor("email_marketing")} handlers={handlers()} />);
  await flush();
};
const copyButton = () => screen.getByRole("button", { name: /^Copy email/ }) as HTMLButtonElement;
const form = () => screen.getByTestId("blanks-fill");
const field = () => screen.getByRole("textbox", { name: "first name" }) as HTMLInputElement;

describe("unsubscribe tags", () => {
  it("accepts each tool's real unsubscribe tag and refuses other merge tags", () => {
    for (const esp of Object.values(ESP_TAGS)) expect(isUnsubscribeLink(esp.unsubscribe)).toBe(true);
    expect(isUnsubscribeLink("{{ unsubscribe_link }}")).toBe(true);
    for (const junk of ["{{first_name}}", "*|FNAME|*", "{% foo %}", "{{x}}}", "{{{x}}", "{{{unsubscribe}}", ESP_TAGS.klaviyo.first_name]) {
      expect(isUnsubscribeLink(junk)).toBe(false);
    }
    expect(linkProblem("[unsubscribe link]", "{{first_name}}")).toBe(LINK_PROBLEM);
    expect(linkProblem("[unsubscribe link]", "*|FNAME|*")).toBe(LINK_PROBLEM);
    expect(linkProblem("[unsubscribe link]", "*|UNSUB|*")).toBeNull();
  });

  it("accepts Klaviyo's unsubscribe tag with link text and SendGrid's raw unsubscribe URLs, and nothing close to them", () => {
    for (const tag of ["{% unsubscribe 'Unsubscribe' %}", '{% unsubscribe "Stop these emails" %}', "{%unsubscribe 'x'%}", "<%asm_group_unsubscribe_raw_url%>", "<%asm_global_unsubscribe_raw_url%>"]) {
      expect(isUnsubscribeLink(tag), tag).toBe(true);
      expect(linkProblem("[unsubscribe link]", tag), tag).toBeNull();
    }
    for (const junk of [
      "{% unsubscribe x %}",
      "{% unsubscribe 'x\" %}",
      "{% unsubscribe '' %}",
      "{% unsubscribe 'a' 'b' %}",
      "{% unsubscribe '{{ first_name }}' %}",
      "{% unsubscribe 'x' }",
      "<%asm_group_unsubscribe_url%>",
      "<%asm_preferences_raw_url%>",
      "<%asm_group_unsubscribe_raw_url%>x",
      "<% asm_group_unsubscribe_raw_url %>",
      "<%ASM_GROUP_UNSUBSCRIBE_RAW_URL%>",
    ]) {
      expect(isUnsubscribeLink(junk), junk).toBe(false);
      expect(linkProblem("[unsubscribe link]", junk), junk).toBe(LINK_PROBLEM);
    }
  });
});

describe("a blank filled with text that looks like a merge tag", () => {
  it("unblocks Copy and copies the typed tag", async () => {
    await mount();
    fireEvent.change(field(), { target: { value: "{{contact.firstname}}" } });
    await flush();
    const btn = copyButton();
    expect(btn.getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByTestId("copy-blank-count")).toBeNull();
    fireEvent.click(btn);
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("Hi {{contact.firstname}},");
    expect(screen.getByRole("status").textContent).toContain("Copied");
  });
});

describe("editing a blank after copying", () => {
  it("drops the Copied line so it does not vouch for text that was never copied", async () => {
    await mount();
    fireEvent.change(field(), { target: { value: "Sam" } });
    await flush();
    fireEvent.click(copyButton());
    await flush();
    expect(screen.getByRole("status").textContent).toContain("Copied");
    fireEvent.click(screen.getByRole("button", { name: /Change/ }));
    await flush();
    fireEvent.change(field(), { target: { value: "Sue" } });
    await flush();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(copyButton());
    await flush();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText.mock.calls[1][0]).toContain("Hi Sue,");
    expect(screen.getByRole("status").textContent).toContain("Copied");
  });
});

describe("first click on Copy right after typing in a blank", () => {
  const press = async (moveFocus: (btn: HTMLButtonElement, input: HTMLInputElement) => void, touch = false) => {
    await mount();
    const input = field();
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "S" } });
    await flush();
    expect(form().getAttribute("data-state")).toBe("open");
    const btn = copyButton();
    const atClick: (string | null)[] = [];
    const spy = () => atClick.push(form().getAttribute("data-state"));
    document.addEventListener("click", spy, true);
    fireEvent.pointerDown(btn);
    if (touch) fireEvent.pointerUp(btn);
    act(() => moveFocus(btn, input));
    expect(form().getAttribute("data-state")).toBe("open");
    if (touch) {
      await flush();
      expect(form().getAttribute("data-state")).toBe("open");
    } else {
      fireEvent.pointerUp(btn);
    }
    fireEvent.click(btn);
    await flush();
    await flush();
    document.removeEventListener("click", spy, true);
    expect(atClick).toEqual(["open"]);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("Hi S,");
    expect(form().getAttribute("data-state")).toBe("filled");
  };

  it("keeps the form in place when the press does not move focus (Safari)", async () => {
    await press((_btn, input) => input.blur());
  });

  it("keeps the form in place when the press moves focus to Copy", async () => {
    await press((btn) => btn.focus());
  });

  it("keeps the form in place on a tap, where focus moves after the finger lifts", async () => {
    await press((btn) => btn.focus(), true);
  });

  it("still collapses at once when focus leaves by keyboard", async () => {
    await mount();
    const input = field();
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "Sam" } });
    await flush();
    act(() => copyButton().focus());
    expect(form().getAttribute("data-state")).toBe("filled");
  });
});

describe("blank form wait after a press", () => {
  type Entry = { type: string; fn: EventListenerOrEventListenerObject; capture: boolean };
  let live: Entry[];
  let timers: Map<number, number>;
  let restore: () => void;
  beforeEach(() => {
    live = [];
    timers = new Map();
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    const setT = window.setTimeout.bind(window);
    const clearT = window.clearTimeout.bind(window);
    const cap = (o?: boolean | AddEventListenerOptions) => (typeof o === "boolean" ? o : !!o?.capture);
    const a = vi.spyOn(window, "addEventListener").mockImplementation((type: string, fn: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) => {
      if (["click", "pointerup", "pointercancel", "contextmenu"].includes(type)) live.push({ type, fn, capture: cap(o) });
      add(type, fn, o);
    });
    const r = vi.spyOn(window, "removeEventListener").mockImplementation((type: string, fn: EventListenerOrEventListenerObject, o?: boolean | EventListenerOptions) => {
      live = live.filter((e) => !(e.type === type && e.fn === fn && e.capture === cap(o)));
      remove(type, fn, o);
    });
    const s = vi.spyOn(window, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const id = setT(() => {
        timers.delete(id as unknown as number);
        fn();
      }, ms) as unknown as number;
      timers.set(id, ms ?? 0);
      return id;
    }) as typeof window.setTimeout);
    const c = vi.spyOn(window, "clearTimeout").mockImplementation((id) => {
      if (id !== undefined) timers.delete(id as number);
      clearT(id);
    });
    restore = () => [a, r, s, c].forEach((m) => m.mockRestore());
  });
  afterEach(() => restore());

  const typed = async () => {
    await mount();
    const input = field();
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "S" } });
    await flush();
    return input;
  };
  const waits = (ms: number) => [...timers.values()].filter((v) => v === ms).length;

  it("unmounting while a press is held leaves no window listener behind", async () => {
    const input = await typed();
    fireEvent.pointerDown(copyButton());
    act(() => input.blur());
    expect(live.map((e) => e.type)).toContain("pointerup");
    expect(live.map((e) => e.type)).toContain("pointercancel");
    cleanup();
    expect(live).toEqual([]);
  });

  it("unmounting inside the 500ms after a release clears the click listener and the timer", async () => {
    const input = await typed();
    const btn = copyButton();
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);
    act(() => input.blur());
    expect(live.map((e) => e.type)).toEqual(["click"]);
    expect(waits(500)).toBe(1);
    cleanup();
    expect(live).toEqual([]);
    expect(waits(500)).toBe(0);
  });

  it("after the 500ms runs out with no click, no click listener is left to fire on a later click", async () => {
    const input = await typed();
    const btn = copyButton();
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);
    act(() => btn.focus());
    expect(input === document.activeElement).toBe(false);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 560));
    });
    expect(form().getAttribute("data-state")).toBe("filled");
    expect(live).toEqual([]);
    expect(waits(500)).toBe(0);
  });

  it("a press released by pointerup leaves no pointercancel listener", async () => {
    const input = await typed();
    const btn = copyButton();
    fireEvent.pointerDown(btn);
    act(() => btn.focus());
    fireEvent.pointerUp(btn);
    await flush();
    expect(form().getAttribute("data-state")).toBe("filled");
    expect(input === document.activeElement).toBe(false);
    expect(live).toEqual([]);
  });

  it("a right-click whose pointerup never comes does not hold the form open on a later keyboard move", async () => {
    const input = await typed();
    fireEvent.pointerDown(document.body, { button: 2 });
    fireEvent.contextMenu(document.body);
    act(() => copyButton().focus());
    expect(form().getAttribute("data-state")).toBe("filled");
    expect(input === document.activeElement).toBe(false);
  });

  it("a right-click outside that takes focus closes the form when the menu opens", async () => {
    const input = await typed();
    fireEvent.pointerDown(document.body, { button: 2 });
    act(() => input.blur());
    expect(form().getAttribute("data-state")).toBe("open");
    fireEvent.contextMenu(document.body);
    await flush();
    expect(form().getAttribute("data-state")).toBe("filled");
    expect(live).toEqual([]);
  });

  it("leaving the window mid-press does not hold the form open on a later keyboard move", async () => {
    await typed();
    fireEvent.pointerDown(document.body);
    fireEvent.blur(window);
    act(() => copyButton().focus());
    expect(form().getAttribute("data-state")).toBe("filled");
  });

  it("leaving the window while a press is held closes the form and drops the wait", async () => {
    const input = await typed();
    fireEvent.pointerDown(document.body);
    act(() => input.blur());
    expect(form().getAttribute("data-state")).toBe("open");
    fireEvent.blur(window);
    await flush();
    expect(form().getAttribute("data-state")).toBe("filled");
    expect(live).toEqual([]);
  });
});

const seqCard = (h: ActionHandlers) => {
  const parts = [
    { label: "Email 1: day 0", content: "Subject: Welcome\n\nHi there." },
    { label: "Email 2: day 3", content: "Subject: Still here\n\nHi again." },
    { label: "Email 3: day 7", content: "Subject: Last one\n\nHi once more." },
  ];
  const a = makeAction("send_message", {
    channel_slug: "email_marketing",
    title: "Welcome series",
    body: { step: { title: "Seq", body: "Why one.", deliverable: { kind: "email", label: "Seq", content: "x", parts } } },
    card_kind: "message",
    primary_label: "Copy email",
    done_label: "I sent it",
  });
  render(<ChannelActionCard action={a} platform={platformFor("email_marketing")} handlers={h} />);
};

describe("copying one email of a sequence", () => {
  it("does not tell the founder to press I did this until every email has been copied", async () => {
    seqCard(handlers());
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Copy email 1" }));
    await flush();
    expect(screen.getByRole("status").textContent).toContain("copy email 2");
    expect(screen.queryByRole("button", { name: "I sent it" })).toBeNull();
    fireEvent.click(screen.getAllByRole("tab")[1]!);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Copy email 2" }));
    await flush();
    expect(screen.getByRole("status").textContent).toContain("copy email 3");
    expect(screen.queryByRole("button", { name: "I sent it" })).toBeNull();
    fireEvent.click(screen.getAllByRole("tab")[2]!);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Copy email 3" }));
    await flush();
    expect(screen.getByRole("status").textContent).toBe("Copied");
    expect(screen.getByRole("button", { name: "I sent it" })).toBeTruthy();
    expect(writeText).toHaveBeenCalledTimes(3);
  });
});

describe("Not now on an email work card", () => {
  it("an email draft snoozes from the card's close button", async () => {
    const h = handlers();
    render(<ChannelActionCard action={card()} platform={platformFor("email_marketing")} handlers={h} />);
    await flush();
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Close/ }));
    await flush();
    expect(h.onSetStatus).toHaveBeenCalledTimes(1);
    expect((h.onSetStatus as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe("snoozed");
  });

  it("a work card with no email snoozes from its Not now button", async () => {
    const h = handlers();
    const a = makeAction("check", { channel_slug: "email_marketing", title: "Tighten the subject line", card_kind: "message", done_label: "I reviewed it", body: { step: { title: "t", body: "b" } } });
    render(<ChannelActionCard action={a} platform={platformFor("email_marketing")} handlers={h} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    fireEvent.click(screen.getByRole("button", { name: "1 week" }));
    await flush();
    expect(h.onSetStatus).toHaveBeenCalledTimes(1);
    expect((h.onSetStatus as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe("snoozed");
  });
});
