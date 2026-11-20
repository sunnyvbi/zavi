// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const looksLikeButton = (el: HTMLElement) => {
  const c = el.className.split(/\s+/);
  expect(c.includes("bg-ink") || (c.includes("border") && c.includes("border-rule") && c.includes("bg-white")), `${el.textContent} fill/border`).toBe(true);
  expect(c, `${el.textContent} pointer`).toContain("cursor-pointer");
  expect(c.some((x) => x.startsWith("hover:")), `${el.textContent} hover`).toBe(true);
};

type Q = { search: string; listId: string; offset: number; limit: number };
type Body = { rows: unknown[]; total: number; counts: unknown; masked: boolean };

const server = vi.hoisted(() => ({
  people: [] as Array<{ id: string; email: string; listId?: string; source?: string }>,
  lists: [] as Array<typeof LIST>,
  hold: null as null | ((q: Q) => boolean),
  blank: null as null | ((q: Q) => boolean),
  held: [] as Array<{ q: Q; release: () => void }>,
  calls: [] as Array<{ method: string; url: string }>,
  suppressed: [] as string[],
  suppSize: 50,
  suppHold: null as null | ((page: number) => boolean),
  suppHeld: [] as Array<{ page: number; release: () => void }>,
}));

const LIST = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Newsletter",
  created_at: "2026-10-01T00:00:00Z",
  latest: { id: "v-a", source_kind: "csv", source_label: "Email", contact_count: 25, created_at: "2026-10-01T00:00:00Z", consented: true },
  active: { id: "v-a", contact_count: 25, sendable: 25, unsubscribed_or_bounced: 0 },
  needs_consent: false,
};

const people = (count: number, prefix = "person") =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i + 1}`, email: `${prefix}${String(i + 1).padStart(2, "0")}@example.com` }));

function contactsPage(q: Q): Body {
  const matches = server.people.filter((p) => (!q.search || p.email.includes(q.search)) && (!q.listId || (p.listId ?? LIST.id) === q.listId));
  return {
    rows: matches.slice(q.offset, q.offset + q.limit).map((p) => ({
      id: p.id,
      email: p.email,
      name: null,
      lists: server.lists.filter((l) => l.id === (p.listId ?? LIST.id)).map((l) => ({ id: l.id, name: l.name })),
      status: "ok",
      source: p.source ?? "csv",
      added_at: "2026-10-01T00:00:00Z",
    })),
    total: matches.length,
    counts: { contacts: server.people.length, lists: server.lists.length, unsubscribed: 0, bounced: 0 },
    masked: false,
  };
}

const parse = (url: string): Q => {
  const s = new URL(`http://x${url}`).searchParams;
  return { search: s.get("search") ?? "", listId: s.get("list_id") ?? "", offset: Number(s.get("offset")), limit: Number(s.get("limit")) };
};

vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? "GET";
    server.calls.push({ method, url });
    const ok = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.startsWith("/api/workspace/email-contacts?")) {
      const q = parse(url);
      const body = server.blank?.(q) ? { ...contactsPage(q), rows: [] } : contactsPage(q);
      if (server.hold?.(q)) {
        await new Promise<void>((release) => server.held.push({ q, release }));
      }
      return ok(body);
    }
    if (url === "/api/workspace/email-lists") return ok({ lists: server.lists });
    if (url.startsWith("/api/workspace/email-lists/") && method === "DELETE") {
      const id = url.split("/").pop();
      server.lists = server.lists.filter((l) => l.id !== id);
      server.people = server.people.filter((p) => (p.listId ?? LIST.id) !== id);
      return ok({ ok: true });
    }
    if (url === "/api/workspace/email-test-lists") return ok({ routes: [], orphans: [] });
    if (url.startsWith("/api/workspace/email-suppressions?")) {
      const page = Number(new URL(`http://x${url}`).searchParams.get("page") ?? "1");
      const size = server.suppSize;
      const body = {
        rows: server.suppressed.slice((page - 1) * size, page * size).map((email) => ({ email, reason: "manual", created_at: "2026-10-26T00:00:00Z" })),
        total: server.suppressed.length,
        page,
        page_size: size,
        masked: false,
      };
      if (server.suppHold?.(page)) {
        await new Promise<void>((release) => server.suppHeld.push({ page, release }));
      }
      return ok(body);
    }
    if (url === "/api/workspace/email-suppressions" && method === "POST") {
      const email = (JSON.parse(String(init?.body)) as { email: string }).email;
      server.suppressed.push(email);
      return ok({ added: true, email, reason: "manual", created_at: "2026-10-26T00:00:00Z" });
    }
    return ok({});
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: () => Promise.resolve(true) }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner", tenantName: "Brightloop" }) }));

import { EmailContactsSection } from "../EmailContactsSection";

const peopleQueries = () => server.calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/workspace/email-contacts?")).map((c) => parse(c.url));
const lastQuery = () => peopleQueries().at(-1)!;
const tableEmails = () => screen.queryAllByTestId("contact-email").map((td) => td.textContent);
const stackedEmails = () =>
  within(screen.getByTestId("contacts-people-stacked"))
    .queryAllByTestId("contact-stacked-row")
    .map((li) => li.querySelectorAll("p")[0]?.textContent);
const pager = () => screen.getByTestId("contacts-people-pager");
const next = () => within(pager()).getByRole("button", { name: "Next" }) as HTMLButtonElement;
const prev = () => within(pager()).getByRole("button", { name: "Previous" }) as HTMLButtonElement;
const range = () => screen.getByTestId("contacts-people-range").textContent;

async function mountOnFirstPage() {
  render(<EmailContactsSection />);
  await waitFor(() => expect(tableEmails()).toHaveLength(10));
}

beforeEach(() => {
  server.people = people(25);
  server.lists = [LIST];
  server.hold = null;
  server.blank = null;
  server.held.length = 0;
  server.calls.length = 0;
  server.suppressed.length = 0;
  server.suppSize = 50;
  server.suppHold = null;
  server.suppHeld.length = 0;
});
afterEach(cleanup);

describe("the Source shown for a person", () => {
  it("says both sources for a person on a mixed list, on the desktop table and the phone rows, and keeps CSV and Database for the rest", async () => {
    server.people = [
      { id: "m", email: "ana@example.com", source: "database_and_csv" },
      { id: "c", email: "bo@example.com", source: "csv" },
      { id: "d", email: "dee@example.com", source: "database" },
    ];
    render(<EmailContactsSection />);
    await waitFor(() => expect(tableEmails()).toHaveLength(3));
    const cell = (email: string) => {
      const row = screen.getAllByTestId("contact-email").find((td) => td.textContent === email)!.closest("tr")!;
      return Array.from(row.querySelectorAll("td")).map((td) => td.textContent);
    };
    const phone = (email: string) => {
      const row = within(screen.getByTestId("contacts-people-stacked")).getAllByTestId("contact-stacked-row").find((li) => li.textContent?.includes(email))!;
      return Array.from(row.querySelectorAll("span")).map((s) => s.textContent);
    };
    expect(cell("ana@example.com")).toContain("Database and CSV");
    expect(cell("ana@example.com")).not.toContain("Database");
    expect(cell("ana@example.com")).not.toContain("CSV");
    expect(phone("ana@example.com")).toContain("Database and CSV");
    expect(phone("ana@example.com")).not.toContain("Database");
    expect(phone("ana@example.com")).not.toContain("CSV");
    expect(cell("bo@example.com")).toContain("CSV");
    expect(phone("bo@example.com")).toContain("CSV");
    expect(cell("dee@example.com")).toContain("Database");
    expect(phone("dee@example.com")).toContain("Database");
  });
});

describe("People pages through 10 at a time", () => {
  it("fetches each page from the server with offset and limit 10, and stops Next on the last page", async () => {
    await mountOnFirstPage();
    expect(peopleQueries()).toEqual([{ search: "", listId: "", offset: 0, limit: 10 }]);
    expect(tableEmails()).toEqual(server.people.slice(0, 10).map((p) => p.email));
    expect(stackedEmails()).toEqual(server.people.slice(0, 10).map((p) => p.email));
    expect(range()).toBe("1–10 of 25");
    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();

    fireEvent.click(next());
    await waitFor(() => expect(range()).toBe("11–20 of 25"));
    expect(lastQuery()).toMatchObject({ offset: 10, limit: 10 });
    expect(tableEmails()).toEqual(server.people.slice(10, 20).map((p) => p.email));
    expect(stackedEmails()).toEqual(server.people.slice(10, 20).map((p) => p.email));
    expect(prev().disabled).toBe(false);

    fireEvent.click(next());
    await waitFor(() => expect(range()).toBe("21–25 of 25"));
    expect(lastQuery()).toMatchObject({ offset: 20, limit: 10 });
    expect(tableEmails()).toEqual(server.people.slice(20).map((p) => p.email));
    expect(stackedEmails()).toHaveLength(5);
    expect(next().disabled).toBe(true);
    const before = peopleQueries().length;
    fireEvent.click(next());
    expect(peopleQueries()).toHaveLength(before);

    fireEvent.click(prev());
    await waitFor(() => expect(range()).toBe("11–20 of 25"));
    expect(lastQuery()).toMatchObject({ offset: 10, limit: 10 });
    expect(peopleQueries().every((q) => q.limit === 10)).toBe(true);
  });

  it("a slow page-2 reply that lands after a newer search never replaces the search results, and the search starts on page 1", async () => {
    server.people = [...people(24), { id: "ada", email: "ada.match@example.com" }];
    await mountOnFirstPage();
    server.hold = (q) => q.offset === 10 && !q.search;

    fireEvent.click(next());
    await waitFor(() => expect(server.held).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("Search contacts"), { target: { value: "ada" } });
    await waitFor(() => expect(tableEmails()).toEqual(["ada.match@example.com"]));
    expect(lastQuery()).toEqual({ search: "ada", listId: "", offset: 0, limit: 10 });

    server.held[0].release();
    await new Promise((r) => setTimeout(r, 50));
    expect(tableEmails()).toEqual(["ada.match@example.com"]);
    expect(stackedEmails()).toEqual(["ada.match@example.com"]);
    expect(screen.queryByTestId("contacts-people-pager")).toBeNull();
    expect(lastQuery()).toEqual({ search: "ada", listId: "", offset: 0, limit: 10 });
  });

  it("typing a search while on page 2 asks for offset 0 and shows page 1 of the matches", async () => {
    server.people = [...people(25), ...people(12, "match")];
    await mountOnFirstPage();
    fireEvent.click(next());
    await waitFor(() => expect(range()).toBe("11–20 of 37"));

    fireEvent.change(screen.getByLabelText("Search contacts"), { target: { value: "match" } });
    await waitFor(() => expect(range()).toBe("1–10 of 12"));
    expect(lastQuery()).toEqual({ search: "match", listId: "", offset: 0, limit: 10 });
    expect(peopleQueries().filter((q) => q.search === "match").map((q) => q.offset)).toEqual([0]);
    expect(tableEmails()).toEqual(server.people.slice(25, 35).map((p) => p.email));
    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(false);
  });

  it("changing the list filter while on page 2 goes back to page 1", async () => {
    await mountOnFirstPage();
    fireEvent.click(next());
    await waitFor(() => expect(range()).toBe("11–20 of 25"));

    fireEvent.change(screen.getByLabelText("Filter by list"), { target: { value: LIST.id } });
    await waitFor(() => expect(lastQuery()).toEqual({ search: "", listId: LIST.id, offset: 0, limit: 10 }));
    await waitFor(() => expect(range()).toBe("1–10 of 25"));
    expect(peopleQueries().filter((q) => q.listId === LIST.id).map((q) => q.offset)).toEqual([0]);
  });

  it("suppressing an address from another tab reloads People on the page you were on", async () => {
    await mountOnFirstPage();
    fireEvent.click(next());
    await waitFor(() => expect(range()).toBe("11–20 of 25"));
    const before = peopleQueries().length;

    fireEvent.click(screen.getByRole("button", { name: "Suppressed" }));
    fireEvent.change(await screen.findByLabelText("Never email"), { target: { value: "x@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByText("Added. Zavi's own sender will not email x@example.com. Campaigns sent through SendGrid, Mailchimp or Klaviyo follow that tool's own unsubscribe list, so add the address there too.");
    fireEvent.click(screen.getByRole("button", { name: "People" }));

    await waitFor(() => expect(peopleQueries().length).toBeGreaterThan(before));
    await waitFor(() => expect(range()).toBe("11–20 of 25"));
    expect(peopleQueries().slice(before).map((q) => q.offset)).toEqual([10]);
    expect(tableEmails()).toEqual(server.people.slice(10, 20).map((p) => p.email));
    expect(stackedEmails()).toEqual(server.people.slice(10, 20).map((p) => p.email));
  });
});

describe("People with 23 contacts", () => {
  const OLD = { ...LIST, id: "22222222-2222-4222-8222-222222222222", name: "Old leads" };

  beforeEach(() => {
    server.people = people(23);
  });

  it("shows 10, then 10, then 3 with Next disabled, and Previous walks back, in the table and the phone list", async () => {
    await mountOnFirstPage();
    expect(stackedEmails()).toEqual(server.people.slice(0, 10).map((p) => p.email));
    expect(range()).toBe("1–10 of 23");
    expect(prev().disabled).toBe(true);

    fireEvent.click(next());
    await waitFor(() => expect(range()).toBe("11–20 of 23"));
    expect(tableEmails()).toEqual(server.people.slice(10, 20).map((p) => p.email));
    expect(stackedEmails()).toEqual(server.people.slice(10, 20).map((p) => p.email));

    fireEvent.click(next());
    await waitFor(() => expect(range()).toBe("21–23 of 23"));
    expect(tableEmails()).toEqual(server.people.slice(20).map((p) => p.email));
    expect(stackedEmails()).toEqual(server.people.slice(20).map((p) => p.email));
    expect(next().disabled).toBe(true);

    fireEvent.click(prev());
    await waitFor(() => expect(range()).toBe("11–20 of 23"));
    expect(stackedEmails()).toEqual(server.people.slice(10, 20).map((p) => p.email));
    fireEvent.click(prev());
    await waitFor(() => expect(range()).toBe("1–10 of 23"));
    expect(prev().disabled).toBe(true);
  });

  it("archiving the list that held every row on page 3 lands on page 2 showing rows 11-20", async () => {
    server.people = server.people.map((p, i) => (i >= 20 ? { ...p, listId: OLD.id } : p));
    server.lists = [LIST, OLD];
    await mountOnFirstPage();
    fireEvent.click(next());
    await waitFor(() => expect(range()).toBe("11–20 of 23"));
    fireEvent.click(next());
    await waitFor(() => expect(range()).toBe("21–23 of 23"));
    const kept = server.people.slice(10, 20).map((p) => p.email);

    fireEvent.click(screen.getByRole("button", { name: "Lists" }));
    fireEvent.click(await screen.findByRole("button", { name: "Archive Old leads" }));
    await waitFor(() => expect(server.calls.some((c) => c.method === "DELETE")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "People" }));

    await waitFor(() => expect(range()).toBe("11–20 of 20"));
    expect(tableEmails()).toEqual(kept);
    expect(stackedEmails()).toEqual(kept);
    expect(screen.queryByText("No one matches.")).toBeNull();
    expect(prev().disabled).toBe(false);
    expect(next().disabled).toBe(true);
    expect(lastQuery()).toMatchObject({ offset: 10, limit: 10 });
  });

  it("removing the only row on page 3 lands on page 2", async () => {
    server.people = [...people(20), { id: "last", email: "last@example.com", listId: OLD.id }];
    server.lists = [LIST, OLD];
    await mountOnFirstPage();
    fireEvent.click(next());
    await waitFor(() => expect(range()).toBe("11–20 of 21"));
    fireEvent.click(next());
    await waitFor(() => expect(range()).toBe("21 of 21"));
    expect(stackedEmails()).toEqual(["last@example.com"]);

    fireEvent.click(screen.getByRole("button", { name: "Lists" }));
    fireEvent.click(await screen.findByRole("button", { name: "Archive Old leads" }));
    fireEvent.click(screen.getByRole("button", { name: "People" }));

    await waitFor(() => expect(range()).toBe("11–20 of 20"));
    expect(tableEmails()).toEqual(server.people.slice(10, 20).map((p) => p.email));
    expect(stackedEmails()).toEqual(server.people.slice(10, 20).map((p) => p.email));
    expect(next().disabled).toBe(true);
  });
});

describe("pager buttons", () => {
  it("Previous and Next read as buttons", async () => {
    await mountOnFirstPage();
    looksLikeButton(next());
    looksLikeButton(prev());
  });
});

describe("Clicking Next fast while a page is still loading never skips a page", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("People: 61 contacts, every reply slow, Next hammered while each page loads, shows every page in order", async () => {
    server.people = people(61);
    await mountOnFirstPage();
    server.hold = () => true;
    const seen = [range()];

    for (let i = 0; i < 6; i++) {
      fireEvent.click(next());
      await waitFor(() => expect(server.held).toHaveLength(1));
      for (let k = 0; k < 4; k++) {
        fireEvent.click(next());
        await settle();
      }
      expect(server.held).toHaveLength(1);
      expect(next().disabled).toBe(true);
      expect(prev().disabled).toBe(true);
      const held = server.held.shift()!;
      held.release();
      await waitFor(() => expect(range()).not.toBe(seen.at(-1)));
      seen.push(range());
    }

    expect(seen).toEqual(["1–10 of 61", "11–20 of 61", "21–30 of 61", "31–40 of 61", "41–50 of 61", "51–60 of 61", "61 of 61"]);
    expect(peopleQueries().map((q) => q.offset)).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect(stackedEmails()).toEqual(["person61@example.com"]);
    expect(next().disabled).toBe(true);
  });

  it("People: a click that lands the instant page 4 arrives moves to page 5 only, and page 4 was on screen", async () => {
    server.people = people(61);
    await mountOnFirstPage();
    fireEvent.click(next());
    await waitFor(() => expect(range()).toBe("11–20 of 61"));
    fireEvent.click(next());
    await waitFor(() => expect(range()).toBe("21–30 of 61"));
    server.hold = (q) => q.offset === 30;

    fireEvent.click(next());
    fireEvent.click(next());
    await waitFor(() => expect(server.held).toHaveLength(1));
    fireEvent.click(next());
    server.held[0].release();
    await waitFor(() => expect(range()).toBe("31–40 of 61"));
    expect(tableEmails()).toEqual(server.people.slice(30, 40).map((p) => p.email));
    expect(peopleQueries().map((q) => q.offset)).toEqual([0, 10, 20, 30]);
  });

  it("Suppressed: 31 addresses, 10 a page, Next hammered while each page loads, shows every page in order", async () => {
    server.suppressed = Array.from({ length: 31 }, (_, i) => `gone${String(i + 1).padStart(2, "0")}@example.com`);
    server.suppSize = 10;
    render(<EmailContactsSection />);
    await waitFor(() => expect(tableEmails()).toHaveLength(10));
    fireEvent.click(screen.getByRole("button", { name: "Suppressed" }));
    await waitFor(() => expect(screen.getByTestId("contacts-suppressed-range").textContent).toBe("1–10 of 31"));
    const spager = () => screen.getByTestId("contacts-suppressed-pager");
    const snext = () => within(spager()).getByRole("button", { name: "Next" }) as HTMLButtonElement;
    const srange = () => screen.getByTestId("contacts-suppressed-range").textContent;
    const suppPages = () =>
      server.calls.filter((c) => c.url.startsWith("/api/workspace/email-suppressions?")).map((c) => Number(new URL(`http://x${c.url}`).searchParams.get("page")));
    server.suppHold = () => true;
    const seen = [srange()];

    for (let i = 0; i < 3; i++) {
      fireEvent.click(snext());
      await waitFor(() => expect(server.suppHeld).toHaveLength(1));
      for (let k = 0; k < 4; k++) {
        fireEvent.click(snext());
        await settle();
      }
      expect(server.suppHeld).toHaveLength(1);
      server.suppHeld.shift()!.release();
      await waitFor(() => expect(srange()).not.toBe(seen.at(-1)));
      seen.push(srange());
    }

    expect(seen).toEqual(["1–10 of 31", "11–20 of 31", "21–30 of 31", "31 of 31"]);
    expect(suppPages()).toEqual([1, 2, 3, 4]);
    expect(snext().disabled).toBe(true);
    const rows = within(screen.getByTestId("contacts-suppressed-stacked")).getAllByTestId("suppressed-stacked-row");
    expect(rows.map((r) => r.querySelector("p")?.textContent)).toEqual(["gone31@example.com"]);
  });

  it("People: a page that comes back empty while the total still counts it steps back one page, never forward to the last page", async () => {
    server.people = people(45);
    await mountOnFirstPage();
    fireEvent.click(next());
    await waitFor(() => expect(range()).toBe("11–20 of 45"));
    fireEvent.click(next());
    await waitFor(() => expect(range()).toBe("21–30 of 45"));
    let blanked = 0;
    server.blank = (q) => q.offset === 30 && blanked++ === 0;
    const seen = new Set<string | null>();
    const watch = new MutationObserver(() => seen.add(screen.queryByTestId("contacts-people-range")?.textContent ?? null));
    watch.observe(document.body, { subtree: true, childList: true, characterData: true });

    fireEvent.click(next());
    await waitFor(() => expect(peopleQueries().length).toBeGreaterThanOrEqual(5));
    await new Promise((r) => setTimeout(r, 30));
    watch.disconnect();

    expect(peopleQueries().map((q) => q.offset)).toEqual([0, 10, 20, 30, 20]);
    expect(range()).toBe("21–30 of 45");
    expect(tableEmails()).toEqual(server.people.slice(20, 30).map((p) => p.email));
    expect([...seen].filter((t) => t && t.startsWith("41"))).toEqual([]);
    expect(next().disabled).toBe(false);

    fireEvent.click(next());
    await waitFor(() => expect(range()).toBe("31–40 of 45"));
    expect(peopleQueries().map((q) => q.offset)).toEqual([0, 10, 20, 30, 20, 30]);
  });
});

describe("Suppressed with a page that empties under you", () => {
  it("a page past the end comes back empty, so it steps back to the last real page with the pager still there", async () => {
    server.suppressed = Array.from({ length: 21 }, (_, i) => `gone${String(i + 1).padStart(2, "0")}@example.com`);
    server.suppSize = 10;
    render(<EmailContactsSection />);
    await waitFor(() => expect(tableEmails()).toHaveLength(10));
    fireEvent.click(screen.getByRole("button", { name: "Suppressed" }));
    const srange = () => screen.getByTestId("contacts-suppressed-range").textContent;
    const snext = () => within(screen.getByTestId("contacts-suppressed-pager")).getByRole("button", { name: "Next" }) as HTMLButtonElement;
    const sprev = () => within(screen.getByTestId("contacts-suppressed-pager")).getByRole("button", { name: "Previous" }) as HTMLButtonElement;
    const suppPages = () =>
      server.calls.filter((c) => c.url.startsWith("/api/workspace/email-suppressions?")).map((c) => Number(new URL(`http://x${c.url}`).searchParams.get("page")));
    await waitFor(() => expect(srange()).toBe("1–10 of 21"));
    fireEvent.click(snext());
    await waitFor(() => expect(srange()).toBe("11–20 of 21"));

    server.suppressed = server.suppressed.slice(0, 20);
    fireEvent.click(snext());
    await waitFor(() => expect(suppPages()).toEqual([1, 2, 3, 2]));
    await waitFor(() => expect(srange()).toBe("11–20 of 20"));

    expect(screen.queryByText("No suppressed addresses yet.")).toBeNull();
    const rows = within(screen.getByTestId("contacts-suppressed-stacked")).getAllByTestId("suppressed-stacked-row");
    expect(rows.map((r) => r.querySelector("p")?.textContent)).toEqual(server.suppressed.slice(10, 20));
    expect(snext().disabled).toBe(true);
    expect(sprev().disabled).toBe(false);
  });
});

describe("The pager row", () => {
  it("People and Suppressed draw the same pager, with a one-row last page labelled 'N of N'", async () => {
    server.people = people(11);
    server.suppressed = Array.from({ length: 11 }, (_, i) => `gone${String(i + 1).padStart(2, "0")}@example.com`);
    server.suppSize = 10;
    await mountOnFirstPage();
    fireEvent.click(next());
    await waitFor(() => expect(range()).toBe("11 of 11"));
    const shape = (el: Element): unknown => ({
      tag: el.tagName,
      cls: el.getAttribute("class"),
      label: el.tagName === "BUTTON" ? el.textContent : undefined,
      disabled: (el as HTMLButtonElement).disabled,
      kids: [...el.children].map(shape),
    });
    const peopleShape = shape(pager());

    fireEvent.click(screen.getByRole("button", { name: "Suppressed" }));
    await waitFor(() => expect(screen.getByTestId("contacts-suppressed-range").textContent).toBe("1–10 of 11"));
    const snext = () => within(screen.getByTestId("contacts-suppressed-pager")).getByRole("button", { name: "Next" });
    fireEvent.click(snext());
    await waitFor(() => expect(screen.getByTestId("contacts-suppressed-range").textContent).toBe("11 of 11"));
    expect(shape(screen.getByTestId("contacts-suppressed-pager"))).toEqual(peopleShape);
    expect(screen.queryByText(/Page \d/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/11[-–]11/);
  });

  it("is a labelled nav with the range first and Previous and Next buttons that stay visible when disabled", async () => {
    await mountOnFirstPage();
    const nav = pager();
    expect(nav.tagName).toBe("NAV");
    expect(nav.getAttribute("aria-label")).toBe("People pages");
    expect(nav.className).toContain("justify-end");
    expect(nav.firstElementChild?.getAttribute("data-testid")).toBe("contacts-people-range");
    for (const b of [prev(), next()]) {
      expect(b.className).toContain("min-h-[48px]");
      expect(b.className).toContain("sm:h-8");
      expect(b.className).toContain("disabled:opacity-40");
      expect(b.className).toContain("border-rule");
    }
    expect(prev().disabled).toBe(true);
  });

  it("holds the height only while the next page loads, then lets a short last page sit right above the pager", async () => {
    server.people = [...people(21), { id: "solo", email: "solo.match@example.com" }];
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.querySelectorAll("[data-testid=contact-stacked-row]").length * 50;
      },
    });
    try {
      await mountOnFirstPage();
      const box = () => screen.getByTestId("contacts-people-stacked").parentElement as HTMLElement;
      expect(box().style.minHeight).toBe("");
      fireEvent.click(next());
      await waitFor(() => expect(range()).toBe("11–20 of 22"));
      expect(box().style.minHeight).toBe("");

      server.hold = (q) => q.offset === 20;
      fireEvent.click(next());
      await waitFor(() => expect(server.held).toHaveLength(1));
      expect(stackedEmails()).toHaveLength(10);
      await waitFor(() => expect(box().style.minHeight).toBe("500px"));
      server.held.splice(0).forEach((h) => h.release());
      await waitFor(() => expect(range()).toBe("21–22 of 22"));
      expect(stackedEmails()).toHaveLength(2);
      expect(box().style.minHeight).toBe("");
      expect(box().nextElementSibling).toBe(pager());

      server.hold = null;
      fireEvent.change(screen.getByLabelText("Search contacts"), { target: { value: "solo" } });
      await waitFor(() => expect(stackedEmails()).toEqual(["solo.match@example.com"]));
      expect(screen.queryByTestId("contacts-people-pager")).toBeNull();
      expect(box().style.minHeight).toBe("");
    } finally {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", desc);
    }
  });
});
