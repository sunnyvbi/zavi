// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Call = { url: string; method: string; body: unknown; form: Record<string, string> | null };
type Reply = { status: number; body: unknown };
type Handler = Reply | (() => Reply | Promise<Reply>);
const calls: Call[] = [];
const routes: Record<string, Handler> = {};
const ws = vi.hoisted(() => ({ role: "owner" as string | null }));

vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? "GET";
    let form: Record<string, string> | null = null;
    let body: unknown = init?.body;
    if (init?.body instanceof FormData) {
      form = {};
      for (const [k, v] of init.body.entries()) if (typeof v === "string") form[k] = v;
    } else if (typeof init?.body === "string") body = JSON.parse(init.body);
    calls.push({ url, method, body, form });
    const key = `${method} ${url}`;
    let h: Handler | undefined = key === "POST /api/workspace/email-lists/preview-csv" && form?.column ? routes["POST counts"] : routes[key];
    if (!h && url.startsWith("/api/workspace/email-contacts?")) h = routes["GET /api/workspace/email-contacts"];
    const r = typeof h === "function" ? await h() : (h ?? { status: 200, body: {} });
    return { ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) };
  },
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: ws.role, tenantName: "Brightloop" }) }));

import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/toast";
import { EmailContactsSection } from "../EmailContactsSection";

const set = (key: string, body: unknown, status = 200) => {
  routes[key] = { status, body };
};
const count = (key: string) => calls.filter((c) => `${c.method} ${c.url}` === key).length;

const LIST_ID = "11111111-1111-4111-8111-111111111111";
const V1 = "22222222-2222-4222-8222-222222222222";
const V2 = "33333333-3333-4333-8333-333333333333";
const NEEDS = {
  id: LIST_ID,
  name: "Newsletter",
  created_at: "2026-10-07T00:00:00Z",
  latest: { id: V1, source_kind: "csv", source_label: "Email", contact_count: 3, created_at: "2026-10-07T00:00:00Z", consented: false },
  active: null,
  needs_consent: true,
};
const CONSENTED = {
  ...NEEDS,
  latest: { ...NEEDS.latest, consented: true },
  active: { id: V1, contact_count: 3, sendable: 2, unsubscribed_or_bounced: 1 },
  needs_consent: false,
};
const CONSENT_URL = `POST /api/workspace/email-lists/${LIST_ID}/versions/${V1}/consent`;
const SAMPLES_URL = `GET /api/workspace/email-lists/${LIST_ID}/contacts?limit=5`;
const SUPP_P1 = "GET /api/workspace/email-suppressions?search=&page=1";

beforeEach(() => {
  vi.spyOn(toast, "add").mockReturnValue("t");
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  ws.role = "owner";
  set("GET /api/workspace/email-lists", { lists: [NEEDS] });
  set("GET /api/workspace/email-contacts", { rows: [], total: 0, counts: { contacts: 3, lists: 1, unsubscribed: 0, bounced: 0 }, masked: false });
  set("GET /api/workspace/email-test-lists", { routes: [], orphans: [] });
  set(SAMPLES_URL, { total: 3, contacts: [{ email: "ada@example.com" }, { email: "bo@example.com" }] });
  set(CONSENT_URL, { active_version_id: V1 });
  set(SUPP_P1, { rows: [{ email: "gone@example.com", reason: "unsubscribed", created_at: "2026-10-01T12:00:00Z" }], total: 1, page: 1, page_size: 50, masked: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount() {
  return render(
    <>
      <ConfirmDialogHost />
      <EmailContactsSection />
    </>,
  );
}

async function openView(name: "Lists" | "Suppressed") {
  mount();
  await screen.findByTestId("stat-contacts");
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
}

const PERSON = { id: "p1", email: "ada@example.com", name: null as string | null, lists: [{ id: LIST_ID, name: "Newsletter" }], status: "ok", source: "csv", added_at: "2026-10-07T00:00:00Z" };

describe("contacts view segments", () => {
  it("each segment says whether it is pressed and shows only its label, since the stats strip already has the numbers", async () => {
    set("GET /api/workspace/email-contacts", { rows: [], total: 0, counts: { contacts: 40, lists: 2, unsubscribed: 3, bounced: 4 }, masked: false });
    mount();
    const group = await screen.findByRole("group", { name: "Contacts view" });
    await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("40"));
    const people = within(group).getByRole("button", { name: "People" });
    const lists = within(group).getByRole("button", { name: "Lists" });
    const supp = within(group).getByRole("button", { name: "Suppressed" });
    expect(group.textContent).toBe("PeopleListsSuppressed");
    expect([people, lists, supp].map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    fireEvent.click(supp);
    expect([people, lists, supp].map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
    expect(await screen.findByText("gone@example.com", { selector: "td" })).toBeTruthy();
  });

  it("the Unsubscribed stat says those people get no email, and no other stat carries that note", async () => {
    set("GET /api/workspace/email-contacts", { rows: [], total: 0, counts: { contacts: 40, lists: 2, unsubscribed: 3, bounced: 4 }, masked: false });
    mount();
    await waitFor(() => expect(screen.getByTestId("stat-unsubscribed").textContent).toBe("3"));
    const cell = screen.getByTestId("stat-unsubscribed").parentElement as HTMLElement;
    expect(within(cell).getByTestId("stat-unsubscribed-note").textContent).toBe("These people won't get your emails.");
    expect(screen.getAllByText("These people won't get your emails.")).toHaveLength(1);
    expect((screen.getByTestId("stat-bounced").parentElement as HTMLElement).textContent).not.toContain("get your emails");
  });

  it("before the counts land the segments show only their labels, never a zero", async () => {
    set("GET /api/workspace/email-contacts", { rows: [], total: 0, masked: false });
    set("GET /api/workspace/email-lists", { lists: [] });
    mount();
    const group = await screen.findByRole("group", { name: "Contacts view" });
    await waitFor(() => expect(count("GET /api/workspace/email-lists")).toBeGreaterThan(0));
    expect(within(group).getByRole("button", { name: "Lists" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "People" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Suppressed" })).toBeTruthy();
  });
});

describe("people table name column", () => {
  it("is hidden while no one in view has a name, and comes back when a search finds a named person", async () => {
    let rows = [PERSON, { ...PERSON, id: "p2", email: "bo@example.com", name: "  " }];
    routes["GET /api/workspace/email-contacts"] = () => ({ status: 200, body: { rows, total: rows.length, counts: { contacts: 2, lists: 1, unsubscribed: 0, bounced: 0 }, masked: false } });
    mount();
    expect(await screen.findByText("ada@example.com", { selector: "td" })).toBeTruthy();
    const table = screen.getByRole("table");
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual(["Email", "Lists", "Status", "Source", "Added", "Actions"]);
    expect(headers.filter((h) => /\[@container\(max-width:640px\)\]:hidden/.test(h.className)).map((h) => h.textContent)).toEqual(["Source", "Added"]);
    expect(table.className).toContain("[@container(max-width:640px)]:min-w-0");
    expect(within(table).queryByText("–")).toBeNull();
    expect(within(table).getAllByRole("row")[1].querySelectorAll("td")).toHaveLength(6);
    rows = [{ ...PERSON, name: "Ada Lovelace" }];
    fireEvent.change(screen.getByLabelText("Search contacts"), { target: { value: "ada" } });
    expect(await screen.findByText("Ada Lovelace", { selector: "td" })).toBeTruthy();
    expect(within(screen.getByRole("table")).getAllByRole("columnheader")[0].textContent).toBe("Name");
  });

  it("keeps every row one line: a missing name reads No name, and long names and list sets truncate with the full text on hover", async () => {
    const rows = [
      { ...PERSON, name: "Old Contact With A Rather Long Name", lists: [{ id: LIST_ID, name: "Newsletter" }, { id: "l2", name: "QA messy 1026" }] },
      { ...PERSON, id: "p2", email: "bo@example.com", name: null },
    ];
    routes["GET /api/workspace/email-contacts"] = () => ({ status: 200, body: { rows, total: 2, counts: { contacts: 2, lists: 2, unsubscribed: 0, bounced: 0 }, masked: false } });
    mount();
    const named = await screen.findByText("Old Contact With A Rather Long Name", { selector: "td" });
    expect(cls(named)).toEqual(expect.arrayContaining(["truncate", "whitespace-nowrap"]));
    expect(named.getAttribute("title")).toBe("Old Contact With A Rather Long Name");
    const lists = within(named.closest("tr")!).getByText("Newsletter, QA messy 1026");
    expect(cls(lists)).toEqual(expect.arrayContaining(["truncate", "whitespace-nowrap"]));
    expect(lists.getAttribute("title")).toBe("Newsletter, QA messy 1026");
    const blankRow = within(screen.getByRole("table")).getAllByRole("row")[2];
    const placeholder = within(blankRow).getByText("No name");
    expect(cls(placeholder)).toContain("text-inkMuted");
    expect(placeholder.closest("td")!.getAttribute("title")).toBeNull();
    expect(screen.getByRole("table").textContent).not.toMatch(/[–—]/);
    for (const td of Array.from(screen.getByRole("table").querySelectorAll("tbody td"))) expect(cls(td)).toContain("whitespace-nowrap");
  });
});

const consentButton = () => screen.findByRole("button", { name: /^Confirm consent/ });

describe("contact lists parity: who may confirm consent", () => {
  it.each(["member", "viewer"])("a %s sees the chip, is told who can confirm, and gets no consent button", async (role) => {
    ws.role = role;
    await openView("Lists");
    expect(await screen.findByText("Needs consent")).toBeTruthy();
    expect(screen.getByText("An owner or admin must confirm consent for this list.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Confirm consent/ })).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/consent"))).toBe(false);
  });

  it.each(["owner", "admin"])("an %s gets the consent button and no who-can line", async (role) => {
    ws.role = role;
    await openView("Lists");
    expect(await consentButton()).toBeTruthy();
    expect(screen.queryByText(/An owner or admin must confirm consent/)).toBeNull();
  });
});

describe("contact lists parity: the consent dialog", () => {
  it("is Zavi's modal dialog with the source, samples and the consent sentence; focus is trapped inside", async () => {
    const native = vi.spyOn(window, "confirm").mockReturnValue(true);
    await openView("Lists");
    fireEvent.click(await consentButton());
    const dialog = await screen.findByRole("alertdialog");
    expect(native).not.toHaveBeenCalled();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("alertdialog", { name: "Confirm consent for Newsletter" })).toBe(dialog);
    expect(within(dialog).getByText("3 contacts from a CSV file, column Email.")).toBeTruthy();
    expect(within(dialog).getByText("ada@example.com")).toBeTruthy();
    expect(within(dialog).getByText("bo@example.com")).toBeTruthy();
    expect(within(dialog).getByText("and 1 more")).toBeTruthy();
    expect(within(dialog).getByText("These people agreed to hear from me.")).toBeTruthy();
    const described = (dialog.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "");
    expect(described.some((t) => t.includes("These people agreed to hear from me."))).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);
    const buttons = [...dialog.querySelectorAll<HTMLElement>("button")];
    buttons[buttons.length - 1].focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it("a database list whose counts are withheld shows no count, only who can see it", async () => {
    ws.role = "member";
    const hidden = {
      ...CONSENTED,
      latest: { ...CONSENTED.latest, source_kind: "database", contact_count: null },
      active: { id: V1, contact_count: null, sendable: null, unsubscribed_or_bounced: null },
      members_hidden: true,
    };
    set("GET /api/workspace/email-lists", { lists: [hidden] });
    await openView("Lists");
    const card = await screen.findByTestId("list-card-count");
    expect(card.textContent).toBe("Only an owner or admin can see who is on this list.");
    expect(screen.queryByText(/can be emailed/)).toBeNull();
    expect(screen.queryByText(/\b0 people\b/)).toBeNull();
  });

  it("People names a hidden database list as owner and admin only, not as empty", async () => {
    ws.role = "member";
    set("GET /api/workspace/email-lists", { lists: [{ ...CONSENTED, latest: { ...CONSENTED.latest, source_kind: "database", contact_count: null }, active: null, members_hidden: true }] });
    set("GET /api/workspace/email-contacts", { rows: [], total: 0, counts: { contacts: 0, lists: 1, unsubscribed: 0, bounced: 0 }, masked: true });
    mount();
    expect(await screen.findByTestId("people-hidden-lists")).toBeTruthy();
    fireEvent.change(await screen.findByLabelText("Filter by list"), { target: { value: LIST_ID } });
    expect((await screen.findAllByText("Only an owner or admin can see who is on this list.")).length).toBeGreaterThan(0);
    expect(screen.queryByText("No one matches.")).toBeNull();
  });

  it("Escape and Cancel record nothing; Yes records that exact import once and the list turns sendable", async () => {
    let consented = false;
    routes["GET /api/workspace/email-lists"] = () => ({ status: 200, body: { lists: [consented ? CONSENTED : NEEDS] } });
    routes[CONSENT_URL] = () => {
      consented = true;
      return { status: 200, body: { active_version_id: V1 } };
    };
    await openView("Lists");
    fireEvent.click(await consentButton());
    fireEvent.keyDown(await screen.findByRole("alertdialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect((screen.getByRole("button", { name: /^Confirm consent/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(count(CONSENT_URL)).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: /^Confirm consent/ }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect((screen.getByRole("button", { name: /^Confirm consent/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(count(CONSENT_URL)).toBe(0);
    expect(screen.getByText("Needs consent")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Confirm consent/ }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Yes, they agreed" }));
    expect(await screen.findByText("2 of 3 can be emailed")).toBeTruthy();
    expect(count(CONSENT_URL)).toBe(1);
    expect(calls.find((c) => `${c.method} ${c.url}` === CONSENT_URL)!.body).toEqual({ confirmed: true });
    expect(screen.queryByText("Needs consent")).toBeNull();
    expect(screen.queryByRole("button", { name: /Confirm consent/ })).toBeNull();
  });

  it("when the recipient preview fails, no dialog opens and nothing is recorded; a retry shows the newest import's addresses", async () => {
    set("GET /api/workspace/email-lists", { lists: [{ ...NEEDS, latest: { ...NEEDS.latest, id: V2, contact_count: 1 } }] });
    set(SAMPLES_URL, { error: { code: "internal_error", message: "Zavi could not load those addresses." } }, 500);
    const native = vi.spyOn(window, "confirm").mockReturnValue(true);
    await openView("Lists");
    fireEvent.click(await consentButton());
    expect((await screen.findByRole("alert")).textContent).toBe("Zavi could not load those addresses.");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(native).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.endsWith("/consent"))).toBe(false);

    set(SAMPLES_URL, { total: 1, contacts: [{ email: "new@example.com" }] });
    set(`POST /api/workspace/email-lists/${LIST_ID}/versions/${V2}/consent`, { active_version_id: V2 });
    await waitFor(() => expect((screen.getByRole("button", { name: /^Confirm consent/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /^Confirm consent/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("new@example.com")).toBeTruthy();
    expect(within(dialog).queryByText("ada@example.com")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, they agreed" }));
    await waitFor(() => expect(count(`POST /api/workspace/email-lists/${LIST_ID}/versions/${V2}/consent`)).toBe(1));
    expect(count(CONSENT_URL)).toBe(0);
  });
});

describe("contact lists parity: list cards", () => {
  it("a newer import waiting for consent: the card keeps the sending import's count", async () => {
    set("GET /api/workspace/email-lists", {
      lists: [{ ...NEEDS, latest: { ...NEEDS.latest, id: V2, source_kind: "database", contact_count: 100 }, active: { id: V1, contact_count: 50, sendable: 50, unsubscribed_or_bounced: 0 } }],
    });
    await openView("Lists");
    const card = (await screen.findByText("Needs consent")).closest("li")!;
    expect(within(card).getByText("50")).toBeTruthy();
    expect(within(card).queryByText("100")).toBeNull();
  });

  it("a list where everyone can be emailed shows no extra count line, and Archive reads as an outlined button, not red", async () => {
    set("GET /api/workspace/email-lists", { lists: [{ ...CONSENTED, active: { ...CONSENTED.active, sendable: 3, unsubscribed_or_bounced: 0 } }] });
    await openView("Lists");
    const archive = await screen.findByRole("button", { name: "Archive Newsletter" });
    const card = archive.closest("li")!;
    expect(within(card).getByText("3")).toBeTruthy();
    expect(card.textContent).not.toMatch(/can be emailed/);
    for (const c of ["border", "border-rule", "bg-white", "cursor-pointer", "hover:bg-creamDeep"]) expect(archive.className.split(/\s+/)).toContain(c);
    expect(archive.querySelector("svg")).toBeNull();
    expect(archive.className).toContain("text-[12px]");
    expect(archive.className).not.toContain("12.5px");
    expect(archive.className).not.toContain("text-danger");
  });

  it("Archive asks first: Cancel sends nothing, confirming archives once and reloads", async () => {
    let archived = false;
    routes["GET /api/workspace/email-lists"] = () => ({ status: 200, body: { lists: archived ? [] : [CONSENTED] } });
    routes[`DELETE /api/workspace/email-lists/${LIST_ID}`] = () => {
      archived = true;
      return { status: 200, body: { ok: true } };
    };
    const native = vi.spyOn(window, "confirm").mockReturnValue(true);
    await openView("Lists");
    fireEvent.click(await screen.findByRole("button", { name: "Archive Newsletter" }));
    let dialog = await screen.findByRole("alertdialog", { name: 'Archive "Newsletter"?' });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(screen.getByRole("button", { name: "Archive Newsletter" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Archive Newsletter" }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive list" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Archive Newsletter" })).toBeNull());
    expect(count(`DELETE /api/workspace/email-lists/${LIST_ID}`)).toBe(1);
    expect(native).not.toHaveBeenCalled();
  });

  it("an Archive that went through but whose list reload failed does not stay on a disabled Archiving", async () => {
    let archived = false;
    routes["GET /api/workspace/email-lists"] = () => (archived ? { status: 500, body: { error: { message: "Lists could not be loaded." } } } : { status: 200, body: { lists: [CONSENTED] } });
    routes[`DELETE /api/workspace/email-lists/${LIST_ID}`] = () => {
      archived = true;
      return { status: 200, body: { ok: true } };
    };
    await openView("Lists");
    fireEvent.click(await screen.findByRole("button", { name: "Archive Newsletter" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive list" }));
    expect(await screen.findByText("Lists could not be loaded.")).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", { name: "Archive Newsletter" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText("Archiving…")).toBeNull();
  });

  it("a failed list read has Retry, and the retry shows the lists", async () => {
    set("GET /api/workspace/email-lists", { error: { message: "Lists could not be loaded." } }, 500);
    await openView("Lists");
    expect(await screen.findByText("Lists could not be loaded.")).toBeTruthy();
    set("GET /api/workspace/email-lists", { lists: [CONSENTED] });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("2 of 3 can be emailed")).toBeTruthy();
    expect(screen.queryByText("Lists could not be loaded.")).toBeNull();
  });

  it("with no lists: the upload, database import and new-list entry points are all there", async () => {
    set("GET /api/workspace/email-lists", { lists: [] });
    await openView("Lists");
    expect(await screen.findByRole("button", { name: /Upload CSV/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New list from CSV/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Import from database/ })).toBeTruthy();
  });
});

describe("contact lists parity: imports", () => {
  const file = (text: string) => new File([text], "people.csv", { type: "text/csv" });
  const importBtn = (dialog: HTMLElement) =>
    within(dialog)
      .getAllByRole("button")
      .find((b) => /^Import/.test(b.textContent ?? "")) as HTMLButtonElement;

  async function openCsv(preview: unknown, text: string) {
    set("POST /api/workspace/email-lists/preview-csv", preview);
    mount();
    await screen.findByTestId("stat-contacts");
    fireEvent.click(screen.getByRole("button", { name: /Upload CSV/ }));
    const dialog = await screen.findByRole("dialog", { name: "Upload contacts" });
    fireEvent.change(within(dialog).getByLabelText("CSV file"), { target: { files: [file(text)] } });
    await within(dialog).findByText("Match columns");
    return dialog;
  }

  it("a CSV import warns that opt-outs from other tools do not come with it", async () => {
    set("POST counts", { columns: [], auto_column: "email", row_count: 1, counts: { new: 1, already_in_contacts: 0, duplicate_in_file: 0, bad: 0, over_limit: 0 } });
    const dialog = await openCsv({ columns: [{ header: "email", samples: ["a@b.co"], has_addresses: true }], auto_column: "email", row_count: 1 }, "email\na@b.co\n");
    expect(within(dialog).getByText("Unsubscribes from other tools don't carry over. Remove those people from the file first, or add them under Suppressed.")).toBeTruthy();
  });

  it("a CSV with two address columns makes the founder choose the email column before Import is allowed", async () => {
    set("GET /api/workspace/email-lists", { lists: [] });
    set("POST counts", { columns: [], auto_column: null, row_count: 1, counts: { new: 1, already_in_contacts: 0, duplicate_in_file: 0, bad: 0, over_limit: 0 } });
    set("POST /api/workspace/email-lists/import-csv", { list_id: "L", version_id: "V", added: 1, invalid: 0, duplicates: 0, over_limit: 0, already_unsubscribed: 0 });
    set("POST /api/workspace/email-lists/L/versions/V/consent", { active_version_id: "V" });
    const dialog = await openCsv(
      {
        columns: [
          { header: "work", samples: ["a@b.co"], has_addresses: true },
          { header: "home", samples: ["c@d.co"], has_addresses: true },
          { header: "city", samples: ["Paris"], has_addresses: false },
        ],
        auto_column: null,
        row_count: 1,
      },
      "work,home,city\na@b.co,c@d.co,Paris\n",
    );
    expect(within(dialog).getByText("Pick the column that has the email address.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("New list name"), { target: { value: "Friends" } });
    fireEvent.click(within(dialog).getByLabelText(/These people agreed to get email from/));
    expect(importBtn(dialog).disabled).toBe(true);
    const city = [...(within(dialog).getByLabelText("city") as HTMLSelectElement).options].find((o) => o.value === "email")!;
    expect(city.disabled).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/preview-csv") && c.form?.column)).toBe(false);

    fireEvent.change(within(dialog).getByLabelText("home"), { target: { value: "email" } });
    await waitFor(() => expect(importBtn(dialog).disabled).toBe(false));
    fireEvent.click(importBtn(dialog));
    await waitFor(() => expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ title: "Imported 1 contact into Friends.", timeout: 3_000 })));
    const imp = calls.find((c) => c.url.endsWith("/import-csv"))!;
    expect(imp.form).toEqual({ column: "home", name: "Friends" });
    expect(screen.queryByText("Imported 1 contact into Friends.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(toast.add).toHaveBeenCalledTimes(1);
  }, 10000);

  it("a refused import shows the server's sentence, keeps the dialog open and records no consent", async () => {
    set("GET /api/workspace/email-lists", { lists: [] });
    set("POST counts", { columns: [], auto_column: "email", row_count: 1, counts: { new: 1, already_in_contacts: 0, duplicate_in_file: 0, bad: 0, over_limit: 0 } });
    set("POST /api/workspace/email-lists/import-csv", { error: { code: "list_name_taken", message: "You already have a list with that name." } }, 409);
    const dialog = await openCsv({ columns: [{ header: "email", samples: ["a@b.co"], has_addresses: true }], auto_column: "email", row_count: 1 }, "email\na@b.co\n");
    fireEvent.change(within(dialog).getByLabelText("New list name"), { target: { value: "Newsletter" } });
    fireEvent.click(within(dialog).getByLabelText(/These people agreed to get email from/));
    await waitFor(() => expect(importBtn(dialog).disabled).toBe(false));
    fireEvent.click(importBtn(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("You already have a list with that name.");
    expect(screen.getByRole("dialog", { name: "Upload contacts" })).toBe(dialog);
    expect(calls.some((c) => c.url.endsWith("/consent"))).toBe(false);
    expect(screen.queryByText(/^Imported/)).toBeNull();
  });

  it("with no database connected, the database import shows a calm empty state with a link to Connectors and no Import button", async () => {
    set("GET /api/workspace/operator-db/tables", { error: { code: "database_not_connected", message: "Connect your database first, then import from it." } }, 409);
    mount();
    await screen.findByTestId("stat-contacts");
    fireEvent.click(screen.getByRole("button", { name: /Import from database/ }));
    const dialog = await screen.findByRole("dialog", { name: "Import from database" });
    const empty = await within(dialog).findByTestId("email-contacts-db-empty");
    expect(empty.textContent).toContain("No database connected yet.");
    expect(within(empty).getByRole("link", { name: "Connect a database" }).getAttribute("href")).toBe("/workspace?tab=brain#connector-operator_db");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Import" })).toBeNull();
    expect(within(dialog).queryByLabelText("Table")).toBeNull();
  });

  it("a real database error still shows in red", async () => {
    set("GET /api/workspace/operator-db/tables", { error: { code: "internal_error", message: "Zavi could not read your database." } }, 500);
    mount();
    await screen.findByTestId("stat-contacts");
    fireEvent.click(screen.getByRole("button", { name: /Import from database/ }));
    const dialog = await screen.findByRole("dialog", { name: "Import from database" });
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Zavi could not read your database.");
    expect(within(dialog).queryByTestId("email-contacts-db-empty")).toBeNull();
  });

  it("a database import copies the chosen column into the chosen list, shows the server's notice and records consent for that import", async () => {
    set("GET /api/workspace/email-lists", { lists: [CONSENTED] });
    set("GET /api/workspace/operator-db/tables", { tables: [{ name: "users", column_count: 3 }] });
    set("GET /api/workspace/operator-db/tables/users/columns", { table: "users", columns: [{ name: "email", type: "text" }, { name: "city", type: "text" }] });
    set("POST /api/workspace/email-lists/import-database", {
      list_id: LIST_ID,
      version_id: V2,
      added: 5000,
      invalid: 0,
      duplicates: 0,
      over_limit: 0,
      already_unsubscribed: 0,
      notice: "Imported the first 5,000 rows. For a larger list, upload a CSV.",
    });
    set(`POST /api/workspace/email-lists/${LIST_ID}/versions/${V2}/consent`, { active_version_id: V2 });
    mount();
    await screen.findByTestId("stat-contacts");
    fireEvent.click(screen.getByRole("button", { name: /Import from database/ }));
    const dialog = await screen.findByRole("dialog", { name: "Import from database" });
    fireEvent.change(await within(dialog).findByLabelText("Table"), { target: { value: "users" } });
    await waitFor(() => expect((within(dialog).getByLabelText("Email column") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(within(dialog).getByLabelText("Email column"), { target: { value: "email" } });
    const go = within(dialog).getByRole("button", { name: "Import" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(within(dialog).getByLabelText(/These people agreed to get email from Brightloop/));
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    expect(await screen.findByText("Imported 5,000 contacts into Newsletter. Imported the first 5,000 rows. For a larger list, upload a CSV.")).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith("/import-database"))!.body).toEqual({ table: "users", column: "email", list_id: LIST_ID });
    expect(count(`POST /api/workspace/email-lists/${LIST_ID}/versions/${V2}/consent`)).toBe(1);
  });
});

describe("contact lists parity: suppressed addresses", () => {
  it("lists who is never emailed, an owner adds one, the list reloads, and search finds it", async () => {
    set("POST /api/workspace/email-suppressions", { added: true, email: "new@example.com", reason: "manual", created_at: "2026-10-16T12:00:00Z" });
    set("GET /api/workspace/email-suppressions?search=new%40example.com&page=1", { rows: [{ email: "new@example.com", reason: "manual", created_at: "2026-10-16T12:00:00Z" }], total: 1, page: 1, page_size: 50, masked: false });
    await openView("Suppressed");
    const row = (await screen.findByText("gone@example.com", { selector: "td" })).closest("tr")!;
    expect(within(row).getByText("Unsubscribed")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Never email"), { target: { value: " new@example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(count("POST /api/workspace/email-suppressions")).toBe(1));
    expect(calls.find((c) => c.method === "POST" && c.url === "/api/workspace/email-suppressions")!.body).toEqual({ email: "new@example.com" });
    expect(await screen.findByText("Added. Zavi's own sender will not email new@example.com. Campaigns sent through SendGrid, Mailchimp or Klaviyo follow that tool's own unsubscribe list, so add the address there too.")).toBeTruthy();
    await waitFor(() => expect(count(SUPP_P1)).toBe(2));
    fireEvent.change(screen.getByLabelText("Search suppressed addresses"), { target: { value: "new@example.com" } });
    expect(await screen.findByText("Added by your team", { selector: "td" })).toBeTruthy();
    expect(screen.queryAllByText("gone@example.com")).toHaveLength(0);
  });

  it.each(["member", "viewer"])("a %s sees masked addresses, is told to search by domain, and cannot add one", async (role) => {
    ws.role = role;
    set(SUPP_P1, { rows: [{ email: "g***@example.com", reason: "bounced", created_at: "2026-10-01T12:00:00Z" }], total: 1, page: 1, page_size: 50, masked: true });
    await openView("Suppressed");
    expect(await screen.findByText("g***@example.com", { selector: "td" })).toBeTruthy();
    expect(screen.getByText(/Search by domain/)).toBeTruthy();
    expect(screen.queryByLabelText("Never email")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });

  it("pages by the server's page size, and a refused add shows the server's sentence", async () => {
    set(SUPP_P1, { rows: [{ email: "a@example.com", reason: "manual", created_at: "2026-10-01T12:00:00Z" }], total: 3, page: 1, page_size: 2, masked: false });
    set("GET /api/workspace/email-suppressions?search=&page=2", { rows: [{ email: "c@example.com", reason: "manual", created_at: "2026-10-01T12:00:00Z" }], total: 3, page: 2, page_size: 2, masked: false });
    set("POST /api/workspace/email-suppressions", { error: { code: "bad_email", message: "That does not look like an email address." } }, 400);
    await openView("Suppressed");
    await screen.findByText("a@example.com", { selector: "td" });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("c@example.com", { selector: "td" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Never email"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("That does not look like an email address.")).toBeTruthy();
    expect(screen.queryByText(/^Added\./)).toBeNull();
  });

  it("a failed read has Retry, and the retry shows the addresses", async () => {
    set(SUPP_P1, { error: { message: "Zavi could not read the suppressed addresses." } }, 500);
    await openView("Suppressed");
    expect(await screen.findByText("Zavi could not read the suppressed addresses.")).toBeTruthy();
    set(SUPP_P1, { rows: [{ email: "gone@example.com", reason: "unsubscribed", created_at: "2026-10-01T12:00:00Z" }], total: 1, page: 1, page_size: 50, masked: false });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("gone@example.com", { selector: "td" })).toBeTruthy();
    expect(screen.queryByText("Zavi could not read the suppressed addresses.")).toBeNull();
  });
});

const cls = (el: Element) => el.className.split(/\s+/);
const sideScrollers = (el: Element | null) => {
  const out: string[] = [];
  for (let n = el; n; n = n.parentElement) if (cls(n).some((c) => c.startsWith("overflow-x"))) out.push(n.tagName);
  return out;
};

describe("people at phone width", () => {
  it("stacks each person with name and email first, then status, lists, source and added, and keeps the wide table for sm and up", async () => {
    const long = "zavi-gs16-qa2@yopmail.com";
    const rows = [
      { ...PERSON, email: long, status: "suppressed", lists: [{ id: LIST_ID, name: "Newsletter" }, { id: "l2", name: "Waitlist" }] },
      { ...PERSON, id: "p2", email: "bo@example.com", name: "Bo Diddley", status: "bounced", source: "database", added_at: "2026-09-03T00:00:00Z" },
    ];
    routes["GET /api/workspace/email-contacts"] = () => ({ status: 200, body: { rows, total: 2, counts: { contacts: 2, lists: 2, unsubscribed: 0, bounced: 1 }, masked: false } });
    mount();
    const stacked = await screen.findByRole("list", { name: "People" });
    expect(cls(stacked)).toContain("sm:hidden");
    expect(cls(stacked)).not.toContain("hidden");
    expect(sideScrollers(stacked)).toEqual([]);

    const table = screen.getByRole("table");
    const wrap = table.parentElement!;
    expect(cls(wrap)).toEqual(expect.arrayContaining(["hidden", "sm:block", "overflow-x-auto"]));
    expect(wrap.contains(stacked)).toBe(false);
    expect(stacked.contains(table)).toBe(false);
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Email", "Lists", "Status", "Source", "Added", "Actions"]);

    const items = within(stacked).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    const texts = (li: HTMLElement) => Array.from(li.children).map((c) => c.textContent);
    const metaRow = (li: HTMLElement) => li.querySelector("[class*='flex-wrap']")!;
    const meta = (li: HTMLElement) => Array.from(metaRow(li).children).map((c) => c.textContent);

    expect(texts(items[0]).slice(0, 1)).toEqual([long]);
    expect(meta(items[0])).toEqual(["Suppressed", "Newsletter, Waitlist", "CSV", "Added Oct 7"]);
    expect(texts(items[1]).slice(0, 2)).toEqual(["Bo Diddley", "bo@example.com"]);
    expect(meta(items[1])).toEqual(["Bounced", "Newsletter", "Database", "Added Sep 3"]);

    const pill = within(items[0]).getByText("Suppressed");
    expect(cls(pill)).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
    expect(cls(metaRow(items[0]))).toEqual(expect.arrayContaining(["flex", "flex-wrap"]));
    expect(cls(within(items[0]).getByText(long, { selector: "p" }))).toContain("[overflow-wrap:anywhere]");
    for (const li of items) expect(li.querySelector("[class*='compact:hidden'],[class*='max-width:640px)]:hidden']")).toBeNull();
  });

  it("stacks each suppressed address with its reason and since date, and keeps the wide table for sm and up", async () => {
    set(SUPP_P1, { rows: [{ email: "gone@example.com", reason: "unsubscribed", created_at: "2026-10-01T12:00:00Z" }, { email: "x@example.com", reason: "bounce", created_at: "2026-09-14T12:00:00Z" }], total: 2, page: 1, page_size: 50, masked: false });
    await openView("Suppressed");
    const stacked = await screen.findByRole("list", { name: "Suppressed addresses" });
    expect(cls(stacked)).toContain("sm:hidden");
    expect(cls(stacked)).not.toContain("hidden");
    expect(sideScrollers(stacked)).toEqual([]);
    const wrap = screen.getByRole("table").parentElement!;
    expect(cls(wrap)).toEqual(expect.arrayContaining(["hidden", "sm:block"]));
    expect(wrap.contains(stacked)).toBe(false);
    const items = within(stacked).getAllByRole("listitem");
    expect(items.map((li) => [li.firstElementChild!.textContent, ...Array.from(li.lastElementChild!.children).map((c) => c.textContent)])).toEqual([
      ["gone@example.com", "Unsubscribed", "Since Oct 1"],
      ["x@example.com", "Bounced", "Since Sep 14"],
    ]);
  });
});
