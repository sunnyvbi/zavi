// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const looksLikeButton = (el: HTMLElement) => {
  const c = el.className.split(/\s+/);
  expect(c.includes("bg-ink") || (c.includes("border") && c.includes("border-rule") && c.includes("bg-white")), `${el.textContent} fill/border`).toBe(true);
  expect(c, `${el.textContent} pointer`).toContain("cursor-pointer");
  expect(c.some((x) => x.startsWith("hover:")), `${el.textContent} hover`).toBe(true);
};

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];
const routes: Record<string, { status: number; body: unknown }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = routes[`${method} ${url}`] ?? { status: 200, body: {} };
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
  },
}));
const toasts = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ toast: toasts }));
const toasted = () => toasts.add.mock.calls.map(([t]) => t.title as string);
const ws = vi.hoisted(() => ({ role: "owner" as string | null }));
const io = vi.hoisted(() => ({ cb: null as null | ((e: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void) }));
class FakeIO {
  constructor(cb: (e: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void) {
    io.cb = cb;
  }
  observe() {}
  disconnect() {}
}
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: ws.role }) }));

import { EmailLearningsBlock, LEARNINGS_COPY, SEEN_AFTER_MS, evidenceLine } from "../EmailLearningsBlock";
import { ChannelSettingsPanels } from "../EmailSettingsPanels";
import { ChannelTabBar } from "../../layout/ChannelTabBar";
import { email_marketing } from "../../actions/platforms/email_marketing";

const lesson = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  text: 'Emails to "Trial users" with a number in the subject got more clicks (3.2% vs 1.5% clicks per delivered email, 12 emails).',
  origin: "zavi",
  status: "active",
  split: "subject_digit",
  list_id: "L1",
  list_name: "Trial users",
  metric: "clicks",
  stats: { n_a: 6, n_b: 6 },
  strength: "firm",
  note: null,
  cant_recheck: false,
  from_zavi: false,
  version: 1,
  updated_at: "2026-10-12T00:00:00Z",
  is_new: false,
  ...over,
});
const view = (items: unknown[], over: Record<string, unknown> = {}) => ({
  items,
  dismissed: 0,
  state: { last_run_at: "2026-10-12T00:00:00Z", full_skipped: 0, kept_stronger: 0, sources: {}, seeded_at: "2026-10-12T00:00:00Z", updated_at: "2026-10-12T00:00:00Z" },
  ...over,
});
const set = (key: string, body: unknown, status = 200) => {
  routes[key] = { status, body };
};

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  ws.role = "owner";
  set("GET /api/workspace/email-learnings", view([lesson()]));
  set("POST /api/workspace/email-learnings", { ok: true, id: "a1", version: 2, status: "active" });
  set("POST /api/workspace/email-learnings/seen", { ok: true, marked: 1 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("evidence line", () => {
  it("names the tool the emails came from when it is known", () => {
    const l = { origin: "zavi", from_zavi: false, stats: { n_a: 6, n_b: 6 }, list_name: "Trial users", split: "subject_digit" } as never;
    expect(evidenceLine({ ...(l as object), route: "mailchimp" } as never)).toBe("From 12 of your past Mailchimp emails to Trial users");
    expect(evidenceLine(l)).toBe("From 12 of your past emails to Trial users");
    expect(evidenceLine({ ...(l as object), origin: "founder" } as never)).toBeNull();
  });
});

describe("What we learned", () => {
  it("is a Settings block of the email row, and the row asks for the 'N new' tab count", () => {
    expect(email_marketing.settingsPanels).toContain("email_learnings");
    expect(email_marketing.settingsBadge).toBe("email_learnings_new");
    render(<ChannelSettingsPanels panels={["email_learnings"]} />);
    expect(screen.getByTestId("email-learnings")).toBeTruthy();
  });

  it("shows each kind of line: Zavi's with its evidence, early, the team's, stale with its note, a suggestion, can't re-check", async () => {
    set(
      "GET /api/workspace/email-learnings",
      view([
        lesson(),
        lesson({ id: "e", strength: "early", text: "Early one" }),
        lesson({ id: "f", origin: "founder", text: "Never email trial users more than once a week.", stats: {}, strength: null }),
        lesson({ id: "s", status: "stale", note: "Newer results disagree with this.", text: "Stale one" }),
        lesson({ id: "g", origin: "founder", status: "suggested", text: "Mention the annual plan", stats: {} }),
        lesson({ id: "c", cant_recheck: true, text: "Old tool one" }),
      ]),
    );
    render(<EmailLearningsBlock />);
    await waitFor(() => expect(screen.getByTestId("email-learnings-list")).toBeTruthy());
    expect(screen.getAllByText("From 12 of your past emails to Trial users").length).toBeGreaterThan(0);
    expect(screen.getByText(LEARNINGS_COPY.early)).toBeTruthy();
    expect(screen.getAllByText(LEARNINGS_COPY.yours).length).toBe(2);
    expect(screen.getByText(LEARNINGS_COPY.stale)).toBeTruthy();
    expect(screen.getByText("Newer results disagree with this.")).toBeTruthy();
    expect(screen.getByText(LEARNINGS_COPY.waiting)).toBeTruthy();
    expect(screen.getByText(LEARNINGS_COPY.cantRecheck)).toBeTruthy();
    expect(screen.getByText("Read it again")).toBeTruthy();
    expect(screen.getByText("Add to the list")).toBeTruthy();
    expect(screen.queryByText(/lines in use/)).toBeNull();
    expect(screen.getByTestId("email-learnings").textContent).not.toContain("teammates still see it as new");
  });

  it("is titled What Zavi learned, with sentence-case pills and no hover-only styling", async () => {
    set("GET /api/workspace/email-learnings", view([lesson({ is_new: true }), lesson({ id: "e", strength: "early", text: "Early one" })], { dismissed: 1 }));
    set("GET /api/workspace/email-learnings/removed", { items: [{ id: "r1", text: "Gone one", version: 1 }] });
    render(<EmailLearningsBlock />);
    await waitFor(() => expect(screen.getByTestId("email-learnings-list")).toBeTruthy());
    expect(screen.getByRole("heading", { level: 3, name: "What Zavi learned" })).toBeTruthy();
    expect(screen.getByTestId("email-learnings").textContent).toContain("Zavi reads these before writing each email.");
    expect(screen.getByTestId("email-learnings").textContent).not.toContain("Add your own rules");
    fireEvent.click(screen.getByTestId("email-learnings-removed-toggle"));
    await waitFor(() => expect(screen.getByText("Gone one")).toBeTruthy());
    fireEvent.click(screen.getByTestId("email-learnings-add"));
    const root = screen.getByTestId("email-learnings");
    looksLikeButton(screen.getByRole("button", { name: "Cancel" }));
    looksLikeButton(screen.getByTestId("email-learnings-removed-toggle"));
    const hovered = [...root.querySelectorAll("*")].filter((el) => el.tagName !== "BUTTON" && /(^|\s|:)hover:/.test(el.getAttribute("class") ?? ""));
    expect(hovered).toEqual([]);
    expect(screen.getByTestId("email-learnings-removed-toggle").className).not.toMatch(/underline/);
    const newPill = screen.getByText("New");
    expect(newPill.className).not.toContain("uppercase");
    expect(newPill.className).toContain("bg-brand/10");
    expect(screen.getByText(LEARNINGS_COPY.early).className).not.toContain("uppercase");
    const textarea = screen.getByLabelText("New line");
    expect(textarea.className).toContain("bg-cream");
    expect(textarea.className).toContain("border-rule");
  });

  it("row actions in Settings are quiet bordered buttons at every width: never underlined, 48px to tap on a phone, 32px on desktop", async () => {
    set(
      "GET /api/workspace/email-learnings",
      view(
        [
          lesson(),
          lesson({ id: "s", status: "stale", note: "Newer results disagree with this.", text: "Stale one" }),
          lesson({ id: "g", origin: "founder", status: "suggested", text: "Mention the annual plan", stats: {} }),
        ],
        { dismissed: 1 },
      ),
    );
    set("GET /api/workspace/email-learnings/removed", { items: [{ id: "r1", text: "Gone one", version: 1 }] });
    render(<EmailLearningsBlock />);
    await waitFor(() => expect(screen.getByTestId("email-learnings-list")).toBeTruthy());
    const toggle = screen.getByTestId("email-learnings-removed-toggle");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("Restore")).toBeTruthy());
    const actions = [
      ...screen.getAllByRole("button", { name: /^Edit:/ }),
      ...screen.getAllByRole("button", { name: /^Remove:/ }),
      screen.getByRole("button", { name: "Read it again" }),
      screen.getByRole("button", { name: "Add to the list" }),
      screen.getByRole("button", { name: "Restore" }),
      toggle,
    ];
    expect(actions).toHaveLength(10);
    for (const b of actions) {
      const cls = (b.getAttribute("class") ?? "").split(/\s+/);
      expect(cls.filter((c) => /(^|:)underline/.test(c))).toEqual([]);
      expect(cls).toContain("min-h-[48px]");
      expect(cls).toContain("border");
      expect(cls).toContain("border-rule");
      expect(cls).toContain("rounded-cta");
      expect(cls).toContain("sm:h-8");
      expect(cls.filter((c) => /^sm:(border-0|bg-transparent|px-0)$/.test(c))).toEqual([]);
      expect(cls.some((c) => c.startsWith("focus-visible:ring"))).toBe(true);
    }
  });

  it("a member's intro does not invite them to add rules", async () => {
    ws.role = "member";
    render(<EmailLearningsBlock />);
    await waitFor(() => expect(screen.getByTestId("email-learnings-list")).toBeTruthy());
    const text = screen.getByTestId("email-learnings").textContent ?? "";
    expect(text).not.toContain("Add your own rules too.");
    expect(text).toContain("you can suggest a line");
  });

  it("an owner edits with the line's version, and the saved sentence shows once the list reads back", async () => {
    render(<EmailLearningsBlock />);
    const edit = await screen.findByRole("button", { name: /^Edit:/ });
    fireEvent.click(edit);
    fireEvent.change(screen.getByLabelText("Edit line"), { target: { value: "My own words" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(toasted()).toContain(LEARNINGS_COPY.saved));
    expect(calls.find((c) => c.method === "POST" && c.url === "/api/workspace/email-learnings")?.body).toEqual({ action: "edit", id: "a1", text: "My own words", version: 1 });
  });

  it("the viewer's own edit, restore or activate is marked seen at the new version before the list reads back, so it never counts as New for them; a failed mark does not block the save", async () => {
    set("GET /api/workspace/email-learnings", view([lesson({ from_zavi: true })], { dismissed: 1 }));
    set("GET /api/workspace/email-learnings/removed", { items: [{ id: "d1", text: "Removed one", origin: "zavi", version: 3 }] });
    const seenEvent = vi.fn();
    window.addEventListener("zavi:email-learnings-seen", seenEvent);
    render(<EmailLearningsBlock />);
    fireEvent.click(await screen.findByRole("button", { name: /^Edit:/ }));
    fireEvent.change(screen.getByLabelText("Edit line"), { target: { value: "My own words" } });
    const before = calls.filter((c) => c.method === "GET" && c.url === "/api/workspace/email-learnings").length;
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(toasted()).toContain(LEARNINGS_COPY.saved));
    const order = calls.map((c) => `${c.method} ${c.url}`);
    const post = order.indexOf("POST /api/workspace/email-learnings");
    const seen = order.indexOf("POST /api/workspace/email-learnings/seen");
    expect(seen).toBeGreaterThan(post);
    expect(order.indexOf("GET /api/workspace/email-learnings", seen)).toBeGreaterThan(seen);
    expect(calls[seen].body).toEqual({ items: [{ id: "a1", version: 2 }] });
    expect(calls.filter((c) => c.method === "GET" && c.url === "/api/workspace/email-learnings").length).toBe(before + 1);
    expect(seenEvent).toHaveBeenCalled();

    set("POST /api/workspace/email-learnings", { ok: true, id: "d1", version: 4, status: "active" });
    set("POST /api/workspace/email-learnings/seen", { error: { code: "x", message: "down" } }, 500);
    fireEvent.click(await screen.findByTestId("email-learnings-removed-toggle"));
    fireEvent.click(await screen.findByText("Restore"));
    await waitFor(() => expect(toasted()).toContain(LEARNINGS_COPY.restored));
    expect(calls.filter((c) => c.url === "/api/workspace/email-learnings/seen").at(-1)?.body).toEqual({ items: [{ id: "d1", version: 4 }] });
    window.removeEventListener("zavi:email-learnings-seen", seenEvent);
  });

  it("adding a line does not mark anything seen", async () => {
    render(<EmailLearningsBlock />);
    await screen.findByTestId("email-learnings-list");
    fireEvent.click(screen.getByTestId("email-learnings-add"));
    fireEvent.change(screen.getByLabelText("New line"), { target: { value: "Mention the annual plan" } });
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/workspace/email-learnings")).toBe(true));
    expect(calls.some((c) => c.url === "/api/workspace/email-learnings/seen")).toBe(false);
  });

  it("a stale tab: the server's sentence, nothing claimed saved", async () => {
    set("POST /api/workspace/email-learnings", { error: { code: "card_changed", message: "This line changed since you opened it. Reload and try again." } }, 409);
    render(<EmailLearningsBlock />);
    fireEvent.click(await screen.findByRole("button", { name: /^Remove:/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/changed since you opened it/));
    expect(toasted()).not.toContain(LEARNINGS_COPY.removed);
  });

  it("a member suggests a line and cannot edit or remove", async () => {
    ws.role = "member";
    render(<EmailLearningsBlock />);
    await screen.findByTestId("email-learnings-list");
    expect(screen.queryByRole("button", { name: /^Edit:/ })).toBeNull();
    fireEvent.click(screen.getByTestId("email-learnings-add"));
    fireEvent.change(screen.getByLabelText("New line"), { target: { value: "Mention the annual plan" } });
    fireEvent.click(screen.getByText("Suggest"));
    await waitFor(() => expect(toasted()).toContain(LEARNINGS_COPY.suggested));
  });

  it("removed lines come back with Restore (their version is sent)", async () => {
    set("GET /api/workspace/email-learnings", view([lesson()], { dismissed: 1 }));
    set("GET /api/workspace/email-learnings/removed", { items: [{ id: "d1", text: "Removed one", origin: "zavi", version: 3 }] });
    render(<EmailLearningsBlock />);
    fireEvent.click(await screen.findByTestId("email-learnings-removed-toggle"));
    fireEvent.click(await screen.findByText("Restore"));
    await waitFor(() => expect(toasted()).toContain(LEARNINGS_COPY.restored));
    expect(calls.filter((c) => c.method === "POST" && c.url === "/api/workspace/email-learnings").at(-1)?.body).toEqual({ action: "restore", id: "d1", version: 3 });
  });

  it("the seed's states: reading, none, a tool unreadable, list full", async () => {
    set("GET /api/workspace/email-learnings", view([], { state: { last_run_at: null, full_skipped: 0, sources: {}, seeded_at: null } }));
    render(<EmailLearningsBlock />);
    expect(await screen.findByTestId("email-learnings-reading")).toBeTruthy();
    cleanup();
    set("GET /api/workspace/email-learnings", view([]));
    render(<EmailLearningsBlock />);
    expect(await screen.findByTestId("email-learnings-none")).toBeTruthy();
    cleanup();
    set(
      "GET /api/workspace/email-learnings",
      view([lesson()], { state: { last_run_at: null, full_skipped: 2, sources: { "klaviyo:x": { route: "klaviyo", status: "could_not_read", count: 0, read_at: "" } }, seeded_at: "2026-10-12T00:00:00Z" } }),
    );
    render(<EmailLearningsBlock />);
    expect(await screen.findByText(LEARNINGS_COPY.unreadable("Klaviyo"))).toBeTruthy();
    expect(screen.getByTestId("email-learnings-full").textContent).toBe(LEARNINGS_COPY.full(2));
  });

  it("must catch: with no email tool connected, an unread or old seed shows Nothing yet, never Reading or Couldn't read", async () => {
    set("GET /api/workspace/email-learnings", view([], { state: { last_run_at: null, full_skipped: 0, sources: {}, seeded_at: null }, tools_connected: false }));
    render(<EmailLearningsBlock />);
    expect(await screen.findByTestId("email-learnings-none")).toBeTruthy();
    expect(screen.queryByTestId("email-learnings-reading")).toBeNull();
    cleanup();
    set(
      "GET /api/workspace/email-learnings",
      view([], { state: { last_run_at: null, full_skipped: 0, kept_stronger: 0, sources: {}, seeded_at: null, seed_requested_at: "2026-01-01T00:00:00Z", updated_at: null }, tools_connected: false }),
    );
    render(<EmailLearningsBlock />);
    expect(await screen.findByTestId("email-learnings-none")).toBeTruthy();
    expect(screen.queryByTestId("email-learnings-failed")).toBeNull();
    expect(screen.queryByText(LEARNINGS_COPY.lookAgain)).toBeNull();
    cleanup();
    set("GET /api/workspace/email-learnings", view([], { state: { last_run_at: null, full_skipped: 0, sources: {}, seeded_at: null }, tools_connected: null }));
    render(<EmailLearningsBlock />);
    expect(await screen.findByTestId("email-learnings-reading")).toBeTruthy();
  });

  it("must catch: New lines are marked seen only once the list is in view a moment, and stay marked New for this visit", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    set("GET /api/workspace/email-learnings", view([lesson({ is_new: true, version: 4 })]));
    const seenEvent = vi.fn();
    window.addEventListener("zavi:email-learnings-seen", seenEvent);
    render(<EmailLearningsBlock />);
    await screen.findByText("New");
    await act(async () => {
      vi.advanceTimersByTime(SEEN_AFTER_MS * 2);
    });
    expect(calls.some((c) => c.url === "/api/workspace/email-learnings/seen")).toBe(false);
    await act(async () => {
      io.cb?.([{ isIntersecting: true, intersectionRatio: 0.1 }]);
    });
    await act(async () => {
      vi.advanceTimersByTime(SEEN_AFTER_MS * 2);
    });
    expect(calls.some((c) => c.url === "/api/workspace/email-learnings/seen")).toBe(false);
    await act(async () => {
      io.cb?.([{ isIntersecting: true, intersectionRatio: 0.9 }]);
    });
    await act(async () => {
      vi.advanceTimersByTime(SEEN_AFTER_MS + 10);
    });
    await waitFor(() => expect(calls.some((c) => c.url === "/api/workspace/email-learnings/seen")).toBe(true));
    expect(calls.find((c) => c.url === "/api/workspace/email-learnings/seen")?.body).toEqual({ items: [{ id: "a1", version: 4 }] });
    await waitFor(() => expect(seenEvent).toHaveBeenCalled());
    expect(screen.getByText("New")).toBeTruthy();
    window.removeEventListener("zavi:email-learnings-seen", seenEvent);
  });

  it("a hidden tab stops the clock: in view but hidden, nothing is marked seen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    set("GET /api/workspace/email-learnings", view([lesson({ is_new: true, version: 2 })]));
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    render(<EmailLearningsBlock />);
    await screen.findByText("New");
    await act(async () => {
      io.cb?.([{ isIntersecting: true, intersectionRatio: 1 }]);
    });
    await act(async () => {
      vi.advanceTimersByTime(SEEN_AFTER_MS * 2);
    });
    expect(calls.some((c) => c.url === "/api/workspace/email-learnings/seen")).toBe(false);
    vis.mockRestore();
  });

  it("a viewer, or a role not loaded yet, reads the list and changes nothing; a viewer is not told to suggest", async () => {
    for (const role of ["viewer", null]) {
      cleanup();
      ws.role = role;
      render(<EmailLearningsBlock />);
      await screen.findByTestId("email-learnings-list");
      expect(screen.queryByTestId("email-learnings-add")).toBeNull();
      expect(screen.queryByRole("button", { name: /^Edit:/ })).toBeNull();
      expect(screen.getByTestId("email-learnings").textContent).not.toMatch(/you can suggest/);
    }
  });

  it("a Zavi line the team edited keeps its evidence, marked edited by your team", async () => {
    set("GET /api/workspace/email-learnings", view([lesson({ origin: "founder", from_zavi: true, text: "My words" })]));
    render(<EmailLearningsBlock />);
    await screen.findByText("My words");
    expect(screen.getByText(LEARNINGS_COPY.edited)).toBeTruthy();
    expect(screen.getByText("From 12 of your past emails to Trial users")).toBeTruthy();
  });

  it("list full says which: every line the team's, or Zavi kept its stronger lessons", async () => {
    set("GET /api/workspace/email-learnings", view([lesson()], { state: { last_run_at: null, full_skipped: 0, kept_stronger: 3, sources: {}, seeded_at: "2026-10-12T00:00:00Z", updated_at: null } }));
    render(<EmailLearningsBlock />);
    expect((await screen.findByTestId("email-learnings-kept")).textContent).toBe(LEARNINGS_COPY.keptStronger(3));
    expect(screen.queryByTestId("email-learnings-full")).toBeNull();
  });

  it("a read that did not finish is never stuck on 'Reading': it says so, and an owner can look again", async () => {
    set(
      "GET /api/workspace/email-learnings",
      view([], { state: { last_run_at: null, full_skipped: 0, kept_stronger: 0, sources: { "mailchimp:x": { route: "mailchimp", status: "partial", count: 3, read_at: "" } }, seeded_at: null, updated_at: new Date().toISOString() } }),
    );
    set("POST /api/workspace/email-learnings/look-again", { ok: true, status: "queued", queued: true, message: "Zavi is reading your past emails again." });
    render(<EmailLearningsBlock />);
    const partialLine = await screen.findByText(LEARNINGS_COPY.partial("Mailchimp"));
    expect(screen.queryByTestId("email-learnings-failed")).toBeNull();
    expect(screen.queryByText(LEARNINGS_COPY.failed)).toBeNull();
    expect(screen.queryByTestId("email-learnings-reading")).toBeNull();
    const retry = screen.getByTestId("email-learnings-look-again");
    expect(retry.textContent).toBe("Try now");
    const row = partialLine.parentElement as HTMLElement;
    expect(row.contains(retry)).toBe(true);
    expect(screen.getAllByRole("button", { name: "Try now" })).toHaveLength(1);
    expect(row.className).toContain("border-rule");
    expect(row.className).not.toMatch(/(^|\s)bg-/);
    expect(row.className).not.toMatch(/warn/);
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText("Zavi is reading your past emails again.")).toBeTruthy());
    cleanup();
    set("GET /api/workspace/email-learnings", view([], { state: { last_run_at: null, full_skipped: 0, kept_stronger: 0, sources: {}, seeded_at: null, seed_requested_at: "2026-01-01T00:00:00Z", updated_at: new Date().toISOString() } }));
    render(<EmailLearningsBlock />);
    expect(await screen.findByTestId("email-learnings-failed")).toBeTruthy();
  });

  it("a failed first read with a tool line shows only the tool line, with Try now on the first line; with no tool line the general line stays", async () => {
    const state = (sources: Record<string, unknown>) => ({ last_run_at: null, full_skipped: 0, kept_stronger: 0, sources, seeded_at: null, updated_at: new Date().toISOString() });
    set("GET /api/workspace/email-learnings", view([], { state: state({ "mailchimp:x": { route: "mailchimp", status: "could_not_read", count: 0, read_at: "" } }) }));
    render(<EmailLearningsBlock />);
    const line = await screen.findByText(LEARNINGS_COPY.unreadable("Mailchimp"));
    expect(screen.queryByText(LEARNINGS_COPY.failed)).toBeNull();
    expect(screen.queryByTestId("email-learnings-failed")).toBeNull();
    expect((line.parentElement as HTMLElement).contains(screen.getByTestId("email-learnings-look-again"))).toBe(true);
    cleanup();
    set("GET /api/workspace/email-learnings", view([], { state: { ...state({}), seed_requested_at: "2026-01-01T00:00:00Z" } }));
    render(<EmailLearningsBlock />);
    const failed = await screen.findByTestId("email-learnings-failed");
    expect(failed.textContent).toContain(LEARNINGS_COPY.failed);
    expect(failed.contains(screen.getByTestId("email-learnings-look-again"))).toBe(true);
  });

  it("the count shows only when the list is full, and the owner intro has no Add your own rules sentence", async () => {
    const many = (k: number) => Array.from({ length: k }, (_, i) => lesson({ id: `l${i}`, text: `Line ${i}` }));
    set("GET /api/workspace/email-learnings", view(many(11)));
    render(<EmailLearningsBlock />);
    await screen.findByText("Line 0");
    expect(screen.queryByText(/lines in use/)).toBeNull();
    expect(screen.getByTestId("email-learnings").textContent).not.toContain("Add your own rules");
    cleanup();
    set("GET /api/workspace/email-learnings", view(many(12)));
    render(<EmailLearningsBlock />);
    await screen.findByText("Line 0");
    expect(screen.getByText("12 of 12 lines in use.")).toBeTruthy();
  });

  it("Look again is asked once while it is in flight, and has no double press", async () => {
    set(
      "GET /api/workspace/email-learnings",
      view([], { state: { last_run_at: null, full_skipped: 0, kept_stronger: 0, sources: { "mailchimp:x": { route: "mailchimp", status: "partial", count: 3, read_at: "" } }, seeded_at: null, updated_at: new Date().toISOString() } }),
    );
    set("POST /api/workspace/email-learnings/look-again", { ok: true, status: "queued", queued: true, message: "Zavi is reading your past emails again." });
    render(<EmailLearningsBlock />);
    const btn = await screen.findByTestId("email-learnings-look-again");
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText("Zavi is reading your past emails again.")).toBeTruthy());
    expect(calls.filter((c) => c.url === "/api/workspace/email-learnings/look-again")).toHaveLength(1);
  });

  it("a failed read has Retry", async () => {
    set("GET /api/workspace/email-learnings", { error: { message: "Could not load." } }, 500);
    render(<EmailLearningsBlock />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/workspace/email-learnings").length).toBe(2));
    set("GET /api/workspace/email-learnings", view([lesson()]));
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
  });

  it("the Settings tab shows 'N new', and nothing at zero", () => {
    const tabs = [["overview", "Overview"], ["settings", "Settings"]] as const;
    render(<ChannelTabBar tabs={tabs} active="overview" onSelect={() => undefined} count={0} settingsCount={2} label="Email campaigns" />);
    expect(screen.getByTestId("channel-tab-settings-new").textContent).toBe("2 new");
    cleanup();
    render(<ChannelTabBar tabs={tabs} active="overview" onSelect={() => undefined} count={0} label="Email campaigns" />);
    expect(screen.queryByTestId("channel-tab-settings-new")).toBeNull();
  });
});

describe("the Removed list stays open and true after a change", () => {
  const removedRow = (id: string, text: string) => ({ id, text, version: 3 });
  const open = async () => {
    render(<EmailLearningsBlock />);
    fireEvent.click(await screen.findByTestId("email-learnings-removed-toggle"));
    await screen.findByText("Line two");
  };
  beforeEach(() => {
    ws.role = "owner";
    set("GET /api/workspace/email-learnings", view([lesson()], { dismissed: 2 }));
    set("GET /api/workspace/email-learnings/removed", { items: [removedRow("d1", "Line one"), removedRow("d2", "Line two")] });
    set("POST /api/workspace/email-learnings", { ok: true, id: "d1", version: 4, status: "active" });
    set("POST /api/workspace/email-learnings/seen", { ok: true });
  });

  it("restoring one keeps the others on screen and reads the list again", async () => {
    await open();
    set("GET /api/workspace/email-learnings/removed", { items: [removedRow("d2", "Line two")] });
    const before = calls.filter((c) => c.url === "/api/workspace/email-learnings/removed").length;
    fireEvent.click(screen.getAllByRole("button", { name: "Restore" })[0]);
    await waitFor(() => expect(screen.queryByText("Line one")).toBeNull());
    expect(screen.getByText("Line two")).toBeTruthy();
    expect(screen.getByTestId("email-learnings-removed-toggle").textContent).toBe("Hide removed");
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/workspace/email-learnings/removed").length).toBe(before + 1));
  });

  it("if the second read fails, the other lines stay and the error shows", async () => {
    await open();
    set("GET /api/workspace/email-learnings/removed", { error: { code: "x", message: "Could not read" } }, 500);
    fireEvent.click(screen.getAllByRole("button", { name: "Restore" })[0]);
    await waitFor(() => expect(screen.queryByText("Line one")).toBeNull());
    expect(screen.getByText("Line two")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBeTruthy();
  });

  it("a closed list is read fresh the next time it opens", async () => {
    await open();
    fireEvent.click(screen.getByTestId("email-learnings-removed-toggle"));
    set("GET /api/workspace/email-learnings/removed", { items: [removedRow("d9", "Line nine")] });
    fireEvent.click(await screen.findByRole("button", { name: /^Remove:/ }));
    await waitFor(() => expect(toasted()).toContain(LEARNINGS_COPY.removed));
    fireEvent.click(screen.getByTestId("email-learnings-removed-toggle"));
    expect(await screen.findByText("Line nine")).toBeTruthy();
  });
});

describe("a saved change", () => {
  it("is a success toast, not a line that stays on the page", async () => {
    ws.role = "owner";
    set("GET /api/workspace/email-learnings", view([lesson()]));
    set("POST /api/workspace/email-learnings", { ok: true, id: "a1", version: 2, status: "dismissed" });
    render(<EmailLearningsBlock />);
    fireEvent.click(await screen.findByRole("button", { name: /^Remove:/ }));
    await waitFor(() => expect(toasts.add).toHaveBeenCalledWith({ type: "success", title: LEARNINGS_COPY.removed, position: "top-center", dismissible: false }));
    expect(screen.queryByText(LEARNINGS_COPY.removed)).toBeNull();
  });
});
