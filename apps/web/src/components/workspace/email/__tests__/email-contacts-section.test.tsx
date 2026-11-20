// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const looksLikeButton = (el: HTMLElement) => {
  const c = el.className.split(/\s+/);
  expect(c.includes("bg-ink") || (c.includes("border") && c.includes("border-rule") && c.includes("bg-white")), `${el.textContent} fill/border`).toBe(true);
  expect(c, `${el.textContent} pointer`).toContain("cursor-pointer");
  expect(c.some((x) => x.startsWith("hover:")), `${el.textContent} hover`).toBe(true);
};

type Call = { url: string; method: string; form: Record<string, string> | null; json: unknown };
type Reply = { status: number; body: unknown };
const calls: Call[] = [];
const state = vi.hoisted(() => ({
  previewQueue: [] as Array<(form: Record<string, string>) => Promise<Reply>>,
  baseQueue: [] as Array<() => Promise<Reply>>,
  role: "owner" as string | null,
  tenantName: "Brightloop" as string | undefined,
  importBody: null as Record<string, unknown> | null,
  importError: null as string | null,
}));

const ok = (body: unknown): Reply => ({ status: 200, body });
const LIST_A = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Newsletter",
  created_at: "2026-10-01T00:00:00Z",
  latest: { id: "v-a", source_kind: "csv", source_label: "Email", contact_count: 12, created_at: "2026-10-01T00:00:00Z", consented: true },
  active: { id: "v-a", contact_count: 12, sendable: 11, unsubscribed_or_bounced: 1 },
  needs_consent: false,
};
const LIST_TEST = { ...LIST_A, id: "33333333-3333-4333-8333-333333333333", name: "Team inbox" };
const COLUMNS = [
  { header: "Email", samples: ["ada@example.com"], has_addresses: true },
  { header: "First name", samples: ["Ada"], has_addresses: false },
  { header: "Surname", samples: ["Lovelace"], has_addresses: false },
  { header: "Notes", samples: ["vip"], has_addresses: false },
];
const BASE_PREVIEW = { columns: COLUMNS, auto_column: "Email", row_count: 5, preview_rows: [["ada@example.com", "Ada", "Lovelace", "vip"]] };

function route(method: string, url: string, form: Record<string, string> | null): Promise<Reply> {
  if (url === "/api/workspace/email-lists" && method === "GET") return Promise.resolve(ok({ lists: [LIST_A, LIST_TEST] }));
  if (url.startsWith("/api/workspace/email-contacts?")) {
    if (url.includes("search=")) return Promise.resolve(ok({ rows: [], total: 0, counts: null, masked: false }));
    return Promise.resolve(ok({ rows: [], total: 0, counts: { contacts: 1234, lists: 2, unsubscribed: 5, bounced: 7 }, masked: false }));
  }
  if (url === "/api/workspace/email-test-lists") {
    return Promise.resolve(ok({ routes: [{ route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: LIST_TEST.id, name: LIST_TEST.name, people: 2, marked: true, looks_like_test: true }] }], orphans: [] }));
  }
  if (url === "/api/workspace/email-lists/preview-csv") {
    if (!form?.column) return state.baseQueue.shift()?.() ?? Promise.resolve(ok(BASE_PREVIEW));
    const next = state.previewQueue.shift();
    if (!next) throw new Error(`unexpected counts call ${JSON.stringify(form)}`);
    return next(form);
  }
  if (url === "/api/workspace/email-lists/import-csv") {
    if (state.importBody) return Promise.resolve(ok(state.importBody));
    return Promise.resolve(ok({ list_id: "L-NEW", version_id: "V-NEW", added: 3, invalid: 1, duplicates: 0, over_limit: 0, already_unsubscribed: 0 }));
  }
  if (url === "/api/workspace/email-lists/import-database" && state.importError) return Promise.resolve({ status: 400, body: { error: { code: "error", message: state.importError } } });
  if (url === "/api/workspace/email-lists/import-database" && state.importBody) return Promise.resolve(ok(state.importBody));
  if (url === "/api/workspace/operator-db/tables") return Promise.resolve(ok({ tables: [{ name: "users", column_count: 3 }, { name: "leads", column_count: 2 }, { name: "plans", column_count: 2 }] }));
  if (url === "/api/workspace/operator-db/tables/users/columns") return Promise.resolve({ status: 500, body: { error: { code: "error", message: "Zavi could not read the columns of users." } } });
  if (url === "/api/workspace/operator-db/tables/plans/columns") return Promise.resolve(ok({ columns: [{ name: "email", type: "text" }, { name: "plan", type: "text" }] }));
  if (url === "/api/workspace/operator-db/tables/leads/columns") return Promise.resolve(ok({ columns: [{ name: "email", type: "text" }] }));
  if (url === "/api/workspace/email-lists/L-NEW/versions/V-NEW/consent") return Promise.resolve(ok({ active_version_id: "V-NEW" }));
  return Promise.resolve(ok({}));
}

vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? "GET";
    let form: Record<string, string> | null = null;
    let json: unknown;
    if (init?.body instanceof FormData) {
      form = {};
      for (const [k, v] of init.body.entries()) if (typeof v === "string") form[k] = v;
    } else if (typeof init?.body === "string") json = JSON.parse(init.body);
    calls.push({ url, method, form, json });
    const r = await route(method, url, form);
    return { ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) };
  },
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: state.role, tenantName: state.tenantName }) }));

import { toast } from "@/components/ui/toast";
import { EmailContactsSection, guessField } from "../EmailContactsSection";

const counts = (c: Partial<{ new: number; already_in_contacts: number; duplicate_in_file: number; bad: number; over_limit: number }>) => ({
  new: 0,
  already_in_contacts: 0,
  duplicate_in_file: 0,
  bad: 0,
  over_limit: 0,
  ...c,
});
const reply = (body: unknown) => () => Promise.resolve(ok({ ...BASE_PREVIEW, counts: body }));
function deferred() {
  let resolve!: (r: Reply) => void;
  const promise = new Promise<Reply>((r) => (resolve = r));
  return { promise, resolve };
}

const countCalls = () => calls.filter((c) => c.url.endsWith("/preview-csv") && c.form?.column);
const importButton = () =>
  within(screen.getByRole("dialog", { name: "Upload contacts" }))
    .getAllByRole("button")
    .find((b) => /^Import/.test(b.textContent ?? "")) as HTMLButtonElement;
const summary = (text: string) => screen.queryByText((_, el) => el?.tagName === "SPAN" && el.textContent === text);

async function openWithFile() {
  render(<EmailContactsSection />);
  await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
  fireEvent.click(screen.getByRole("button", { name: /Upload CSV/ }));
  const dialog = await screen.findByRole("dialog", { name: "Upload contacts" });
  expect(within(dialog).getByText("Drop a CSV here or choose a file")).toBeTruthy();
  expect(within(dialog).getByText("Needs an email column")).toBeTruthy();
  const file = new File(["Email,First name,Surname,Notes\nada@example.com,Ada,Lovelace,vip\n"], "waitlist.csv", { type: "text/csv" });
  fireEvent.change(within(dialog).getByLabelText("CSV file"), { target: { files: [file] } });
  await within(dialog).findByText("Match columns");
  return dialog;
}

let toastSpy: MockInstance<Parameters<typeof toast.add>, ReturnType<typeof toast.add>>;
beforeEach(() => {
  toastSpy = vi.spyOn(toast, "add").mockReturnValue("t");
  calls.length = 0;
  state.previewQueue = [];
  state.baseQueue = [];
  state.role = "owner";
  state.tenantName = "Brightloop";
  state.importBody = null;
  state.importError = null;
});
afterEach(() => {
  cleanup();
  toastSpy.mockRestore();
});

describe("EmailContactsSection", () => {
  it("shows the four stats from the server and no test list in Add to list", async () => {
    state.previewQueue.push(reply(counts({ new: 2, already_in_contacts: 1, bad: 1 })));
    const dialog = await openWithFile();
    expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234");
    expect(screen.getByTestId("stat-bounced").textContent).toBe("7");
    const target = within(dialog).getByLabelText("Add to list") as HTMLSelectElement;
    expect([...target.options].map((o) => o.textContent)).toEqual(["Newsletter", "New list…"]);
  });

  it("a search page that carries no counts keeps the last stats instead of blanking or zeroing them", async () => {
    render(<EmailContactsSection />);
    await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
    fireEvent.change(screen.getByLabelText("Search contacts"), { target: { value: "ada" } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("search=ada"))).toBe(true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234");
    expect(screen.getByTestId("stat-unsubscribed").textContent).toBe("5");
    expect(screen.getByTestId("stat-bounced").textContent).toBe("7");
    expect(screen.getByTestId("stat-lists").textContent).toBe("2");
  });

  it("guesses the mapping, sends it for the dry run, and a mapping change refetches and relabels the button; a stale reply is dropped", async () => {
    const slow = deferred();
    state.previewQueue.push(() => slow.promise);
    const dialog = await openWithFile();
    expect((within(dialog).getByLabelText("Email") as HTMLSelectElement).value).toBe("email");
    expect((within(dialog).getByLabelText("First name") as HTMLSelectElement).value).toBe("first");
    expect((within(dialog).getByLabelText("Surname") as HTMLSelectElement).value).toBe("last");
    expect((within(dialog).getByLabelText("Notes") as HTMLSelectElement).value).toBe("skip");
    await waitFor(() => expect(countCalls()).toHaveLength(1));
    expect(countCalls()[0].form).toEqual({ column: "Email", first_column: "First name", last_column: "Surname", list_id: LIST_A.id });

    state.previewQueue.push(reply({ ...counts({ new: 4, bad: 3 }), already_on_list: 2 }));
    fireEvent.change(within(dialog).getByLabelText("Surname"), { target: { value: "skip" } });
    await waitFor(() => expect(countCalls()).toHaveLength(2));
    expect(countCalls()[1].form).toEqual({ column: "Email", first_column: "First name", list_id: LIST_A.id });
    await waitFor(() => expect(importButton().textContent).toBe("Import 4 contacts"));
    expect(summary("2 already on this list")).toBeTruthy();
    expect(summary("3 bad addresses")).toBeTruthy();
    expect(summary("4 new")).toBeTruthy();

    await act(async () => {
      slow.resolve(ok({ ...BASE_PREVIEW, counts: counts({ new: 99 }) }));
      await slow.promise;
    });
    expect(importButton().textContent).toBe("Import 4 contacts");

    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "skip" } });
    expect(within(dialog).getByText("Pick the column that has the email address.")).toBeTruthy();
    expect(importButton().textContent).toBe("Import");
    expect(importButton().disabled).toBe(true);
    expect(countCalls()).toHaveLength(2);
  });

  it("picking a field already used moves it, so only one column is ever the first name", async () => {
    state.previewQueue.push(reply(counts({ new: 1 })), reply(counts({ new: 1 })));
    const dialog = await openWithFile();
    fireEvent.change(within(dialog).getByLabelText("Notes"), { target: { value: "first" } });
    expect((within(dialog).getByLabelText("First name") as HTMLSelectElement).value).toBe("skip");
    await waitFor(() => expect(countCalls().at(-1)?.form).toEqual({ column: "Email", first_column: "Notes", last_column: "Surname", list_id: LIST_A.id }));
    const opt = [...(within(dialog).getByLabelText("Notes") as HTMLSelectElement).options].find((o) => o.value === "email")!;
    expect(opt.disabled).toBe(true);
  });

  it("the import stays off until consent is ticked and a new list is named, and nothing to import keeps it off", async () => {
    state.previewQueue.push(reply(counts({ new: 0, already_in_contacts: 0, bad: 4 })));
    const dialog = await openWithFile();
    await waitFor(() => expect(summary("4 bad addresses")).toBeTruthy());
    fireEvent.click(within(dialog).getByLabelText("These people agreed to get email from Brightloop"));
    expect(importButton().disabled).toBe(true);
    expect(importButton().textContent).toBe("Import");

    state.previewQueue.push(reply(counts({ new: 3 })));
    fireEvent.change(within(dialog).getByLabelText("Surname"), { target: { value: "skip" } });
    await waitFor(() => expect(importButton().textContent).toBe("Import 3 contacts"));
    expect(importButton().disabled).toBe(false);
    fireEvent.click(within(dialog).getByLabelText("These people agreed to get email from Brightloop"));
    expect(importButton().disabled).toBe(true);
    fireEvent.click(within(dialog).getByLabelText("These people agreed to get email from Brightloop"));
    state.previewQueue.push(reply(counts({ new: 3 })));
    fireEvent.change(within(dialog).getByLabelText("Add to list"), { target: { value: "__new__" } });
    expect(importButton().disabled).toBe(true);
    await waitFor(() => expect(countCalls().at(-1)?.form).toEqual({ column: "Email", first_column: "First name" }));
    await waitFor(() => expect(importButton().textContent).toBe("Import 3 contacts"));
    fireEvent.change(within(dialog).getByLabelText("New list name"), { target: { value: "  " } });
    expect(importButton().disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("New list name"), { target: { value: "Waitlist" } });
    expect(importButton().disabled).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/import-csv"))).toBe(false);
  });

  it("a file of only erased addresses says so, imports nothing and asks for no consent", async () => {
    state.importBody = { list_id: LIST_A.id, version_id: null, added: 0, invalid: 0, duplicates: 0, over_limit: 0, already_unsubscribed: 0, skipped_erased: 1 };
    state.previewQueue.push(reply({ ...counts({}), already_on_list: 0, skipped_erased: 1 }));
    const dialog = await openWithFile();
    await waitFor(() => expect(summary("1 erased, will be skipped")).toBeTruthy());
    expect(importButton().textContent).toBe("Import");
    expect(importButton().disabled).toBe(true);
    fireEvent.click(within(dialog).getByLabelText("These people agreed to get email from Brightloop"));
    await waitFor(() => expect(importButton().disabled).toBe(false));
    fireEvent.click(importButton());
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(toastSpy.mock.calls[0][0]).toMatchObject({ title: `Skipped 1 erased contact. Nothing was imported into ${LIST_A.name}.` });
    expect(calls.some((c) => c.url.endsWith("/consent"))).toBe(false);
  });

  it("a mixed file names both what came in and what was skipped, and consents to the new version", async () => {
    state.importBody = { list_id: "L-NEW", version_id: "V-NEW", added: 2, invalid: 0, duplicates: 0, over_limit: 0, already_unsubscribed: 0, skipped_erased: 3 };
    state.previewQueue.push(reply({ ...counts({ new: 2 }), already_on_list: 0, skipped_erased: 3 }));
    const dialog = await openWithFile();
    await waitFor(() => expect(importButton().textContent).toBe("Import 2 contacts"));
    fireEvent.click(within(dialog).getByLabelText("These people agreed to get email from Brightloop"));
    fireEvent.click(importButton());
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(toastSpy.mock.calls[0][0]).toMatchObject({ title: `Imported 2 contacts into ${LIST_A.name}. Skipped 3 erased contacts.` });
    expect(calls.some((c) => c.url.endsWith("/L-NEW/versions/V-NEW/consent"))).toBe(true);
  });

  it("an owner's import sends the email, first and last columns, then records consent for that exact version", async () => {
    state.previewQueue.push(reply({ ...counts({ new: 2 }), already_on_list: 1 }));
    const dialog = await openWithFile();
    await waitFor(() => expect(importButton().textContent).toBe("Import 2 contacts"));
    state.previewQueue.push(reply(counts({ new: 2, already_in_contacts: 1 })));
    fireEvent.change(within(dialog).getByLabelText("Add to list"), { target: { value: "__new__" } });
    await waitFor(() => expect(importButton().textContent).toBe("Import 3 contacts"));
    fireEvent.change(within(dialog).getByLabelText("New list name"), { target: { value: " Waitlist " } });
    fireEvent.click(within(dialog).getByLabelText("These people agreed to get email from Brightloop"));
    fireEvent.click(importButton());
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(toastSpy).toHaveBeenCalledWith({ type: "success", title: "Imported 3 contacts into Waitlist.", position: "top-center", dismissible: false, timeout: 3_000 });
    expect(screen.queryByText("Imported 3 contacts into Waitlist.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    const imp = calls.find((c) => c.url.endsWith("/import-csv"))!;
    expect(imp.form).toEqual({ column: "Email", name: "Waitlist", first_column: "First name", last_column: "Surname" });
    const order = calls.map((c) => c.url).filter((u) => u.endsWith("/import-csv") || u.endsWith("/consent"));
    expect(order).toEqual(["/api/workspace/email-lists/import-csv", "/api/workspace/email-lists/L-NEW/versions/V-NEW/consent"]);
    expect(calls.find((c) => c.url.endsWith("/consent"))!.json).toEqual({ confirmed: true });
    expect(screen.queryByRole("dialog", { name: "Upload contacts" })).toBeNull();
  });

  it("a member can upload but never records consent, is told who must, and sees no database import", async () => {
    state.role = "member";
    state.tenantName = undefined;
    state.previewQueue.push(reply(counts({ new: 3 })));
    render(<EmailContactsSection />);
    await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
    expect(screen.queryByRole("button", { name: /Import from database/ })).toBeNull();
    cleanup();
    calls.length = 0;
    const dialog = await openWithFile();
    expect(within(dialog).getByText("An owner or admin must confirm this before Zavi can email them.")).toBeTruthy();
    await waitFor(() => expect(importButton().textContent).toBe("Import 3 contacts"));
    fireEvent.click(within(dialog).getByLabelText("These people agreed to get email from you"));
    fireEvent.click(importButton());
    expect(await screen.findByText("Imported 3 contacts into Newsletter. An owner or admin must confirm consent before Zavi can email them.")).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith("/import-csv"))!.form).toMatchObject({ list_id: LIST_A.id, column: "Email" });
    expect(calls.some((c) => c.url.endsWith("/consent"))).toBe(false);
  });

  it("a clean import fires one 3 second toast and no banner, and a later re-render or list refresh does not fire it again", async () => {
    state.previewQueue.push(reply(counts({ new: 3 })));
    const dialog = await openWithFile();
    await waitFor(() => expect(importButton().textContent).toBe("Import 3 contacts"));
    fireEvent.click(within(dialog).getByLabelText("These people agreed to get email from Brightloop"));
    fireEvent.click(importButton());
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Upload contacts" })).toBeNull());
    expect(screen.queryByText(/contacts into/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    await act(async () => {
      await new Promise((res) => setTimeout(res, 50));
    });
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });

  it("an import that leaves something to read (consent not recorded) stays as a banner and fires no toast", async () => {
    state.role = "member";
    state.tenantName = undefined;
    state.previewQueue.push(reply(counts({ new: 3 })));
    const dialog = await openWithFile();
    await waitFor(() => expect(importButton().textContent).toBe("Import 3 contacts"));
    fireEvent.click(within(dialog).getByLabelText("These people agreed to get email from you"));
    fireEvent.click(importButton());
    expect(await screen.findByText(/An owner or admin must confirm consent/)).toBeTruthy();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("the import result stays on the page past 3 seconds until the founder dismisses it", async () => {
    state.role = "member";
    state.tenantName = undefined;
    state.previewQueue.push(reply(counts({ new: 3 })));
    const dialog = await openWithFile();
    await waitFor(() => expect(importButton().textContent).toBe("Import 3 contacts"));
    fireEvent.click(within(dialog).getByLabelText("These people agreed to get email from you"));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.click(importButton());
      await screen.findByText(/^Imported 3 contacts into Newsletter\./);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(screen.getByText(/^Imported 3 contacts into Newsletter\./)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/^Imported 3 contacts into Newsletter\./)).toBeNull();
  });

  it.each([
    ["owner", true],
    ["admin", true],
    ["member", false],
    ["viewer", false],
    [null, false],
  ])("a %s sees Archive on a list card: %s", async (role, shown) => {
    state.role = role;
    render(<EmailContactsSection />);
    await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
    fireEvent.click(screen.getByRole("button", { name: /^Lists/ }));
    const card = (await screen.findAllByText("Newsletter")).map((el) => el.closest("li")).find(Boolean)!;
    expect(within(card).queryByRole("button", { name: /^Archive/ }) !== null).toBe(shown);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("a test list shows its chip, and the dashed New list from CSV tile is gone", async () => {
    render(<EmailContactsSection />);
    await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
    fireEvent.click(screen.getByRole("button", { name: /^Lists/ }));
    const cardOf = async (name: string) => (await screen.findAllByText(name)).map((el) => el.closest("li")).find(Boolean)!;
    expect(within(await cardOf("Team inbox")).getByText("Test")).toBeTruthy();
    expect(within(await cardOf("Newsletter")).queryByText("Test")).toBeNull();
    expect(screen.queryByRole("button", { name: /New list from CSV/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Upload CSV/ })).toBeTruthy();
  });
});

describe("upload dialog before a file is picked", () => {
  it("has no footer and no Import button until a file is read, then shows them", async () => {
    render(<EmailContactsSection />);
    await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
    fireEvent.click(screen.getByRole("button", { name: /Upload CSV/ }));
    const dialog = await screen.findByRole("dialog", { name: "Upload contacts" });
    const importLike = () => within(dialog).queryAllByRole("button").filter((b) => /^Import/.test(b.textContent ?? ""));
    expect(importLike()).toHaveLength(0);
    expect(within(dialog).queryByRole("button", { name: "Choose another file" })).toBeNull();
    state.previewQueue.push(reply(counts({ new: 1 })));
    const file = new File(["Email\na@b.co\n"], "x.csv", { type: "text/csv" });
    fireEvent.change(within(dialog).getByLabelText("CSV file"), { target: { files: [file] } });
    await within(dialog).findByText("Match columns");
    expect(importLike()).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: "Choose another file" })).toBeTruthy();
  });
});

describe("header actions", () => {
  it("keeps the full names for assistive tech and a short label for narrow widths", async () => {
    render(<EmailContactsSection />);
    await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
    expect(screen.getByRole("heading", { level: 2, name: "Contacts" })).toBeTruthy();
    const db = screen.getByRole("button", { name: "Import from database" });
    expect(within(db).getByText("From database").className).toContain("[@container(max-width:640px)]:inline");
    expect(within(db).getByText("Import from database").className).toContain("[@container(max-width:640px)]:hidden");
    looksLikeButton(db);
    looksLikeButton(screen.getByRole("button", { name: "Upload CSV" }));
    const actions = screen.getByTestId("email-contacts-actions");
    expect(actions.contains(screen.getByRole("button", { name: "Upload CSV" }))).toBe(true);
    expect(actions.className).toContain("[@container(max-width:640px)]:grid-cols-2");
  });
});

describe("adding a file to an existing list", () => {
  it("asks for counts against the picked list, shows who is already on it, and re-asks against the workspace when New list is picked", async () => {
    state.previewQueue.push((form) =>
      Promise.resolve(ok({ ...BASE_PREVIEW, counts: form.list_id === LIST_A.id ? { ...counts({ new: 2 }), already_on_list: 1 } : counts({ new: 0, already_in_contacts: 3 }) })),
    );
    const dialog = await openWithFile();
    await waitFor(() => expect(summary("1 already on this list")).toBeTruthy());
    expect(countCalls()[0].form?.list_id).toBe(LIST_A.id);
    expect(summary("2 new")).toBeTruthy();
    expect(summary("0 already in contacts")).toBeNull();
    expect(importButton().textContent).toBe("Import 2 contacts");

    state.previewQueue.push((form) => Promise.resolve(ok({ ...BASE_PREVIEW, counts: form.list_id ? counts({ new: 99 }) : counts({ new: 1, already_in_contacts: 2 }) })));
    fireEvent.change(within(dialog).getByLabelText("Add to list"), { target: { value: "__new__" } });
    await waitFor(() => expect(summary("2 already in contacts")).toBeTruthy());
    expect(countCalls()).toHaveLength(2);
    expect(countCalls()[1].form?.list_id).toBeUndefined();
    expect(summary("1 already on this list")).toBeNull();
    expect(summary("1 new")).toBeTruthy();
    expect(importButton().textContent).toBe("Import 3 contacts");
  });

  it("a file where everyone is already on the picked list keeps Import off, says why, and never imports; New list still offers them all", async () => {
    state.previewQueue.push((form) => Promise.resolve(ok({ ...BASE_PREVIEW, counts: form.list_id === LIST_A.id ? { ...counts({ new: 0 }), already_on_list: 50 } : counts({ new: 99 }) })));
    const dialog = await openWithFile();
    await waitFor(() => expect(summary("50 already on this list")).toBeTruthy());
    expect(summary("0 new")).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText("These people agreed to get email from Brightloop"));
    expect(importButton().disabled).toBe(true);
    expect(importButton().textContent).toBe("Import");
    expect(within(dialog).getByRole("status").textContent).toBe("Everyone in this file is already on this list.");
    fireEvent.click(importButton());
    await act(async () => {});
    expect(calls.some((c) => c.url.endsWith("/import-csv"))).toBe(false);

    state.previewQueue.push((form) => Promise.resolve(ok({ ...BASE_PREVIEW, counts: form.list_id ? counts({ new: 0 }) : counts({ new: 10, already_in_contacts: 40 }) })));
    fireEvent.change(within(dialog).getByLabelText("Add to list"), { target: { value: "__new__" } });
    await waitFor(() => expect(importButton().textContent).toBe("Import 50 contacts"));
    expect(within(dialog).getByRole("status").textContent).toBe("Bad addresses and repeats are skipped.");
    fireEvent.change(within(dialog).getByLabelText("New list name"), { target: { value: "Waitlist" } });
    expect(importButton().disabled).toBe(false);
  });
});

describe("repeats inside the file", () => {
  it("shows the server's duplicate count as its own chip, never folds it into new, and follows a refetch", async () => {
    state.previewQueue.push(reply(counts({ new: 2, already_in_contacts: 0, duplicate_in_file: 1, bad: 1 })));
    await openWithFile();
    await waitFor(() => expect(summary("1 duplicate")).toBeTruthy());
    expect(summary("2 new")).toBeTruthy();
    expect(summary("0 already in contacts")).toBeNull();
    expect(summary("1 bad address")).toBeTruthy();
    expect(importButton().textContent).toBe("Import 2 contacts");

    state.previewQueue.push(reply(counts({ new: 1, duplicate_in_file: 3 })));
    fireEvent.change(screen.getByLabelText("Surname"), { target: { value: "skip" } });
    await waitFor(() => expect(summary("3 duplicates")).toBeTruthy());
    expect(summary("1 duplicate")).toBeNull();
    expect(importButton().textContent).toBe("Import 1 contact");
  });

  it("a clean file shows only the new count, never a row of zeros", async () => {
    state.previewQueue.push(reply(counts({ new: 3 })));
    await openWithFile();
    await waitFor(() => expect(summary("3 new")).toBeTruthy());
    expect(summary("0 duplicates")).toBeNull();
    expect(summary("0 bad addresses")).toBeNull();
    expect(summary("0 already in contacts")).toBeNull();
  });

  it("nothing new still says 0 new", async () => {
    state.previewQueue.push(reply(counts({ new: 0, already_in_contacts: 2 })));
    await openWithFile();
    await waitFor(() => expect(summary("0 new")).toBeTruthy());
    expect(summary("2 already in contacts")).toBeTruthy();
  });
});

describe("full name columns", () => {
  const preview = (headers: string[]) => ({
    columns: headers.map((h, i) => ({ header: h, samples: [i === 0 ? "ada@example.com" : "Ada Lovelace"], has_addresses: i === 0 })),
    auto_column: headers[0],
    row_count: 1,
    preview_rows: [headers.map((_, i) => (i === 0 ? "ada@example.com" : "Ada Lovelace"))],
  });

  async function openWith(headers: string[]) {
    state.baseQueue.push(() => Promise.resolve(ok(preview(headers))));
    render(<EmailContactsSection />);
    await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
    fireEvent.click(screen.getByRole("button", { name: /Upload CSV/ }));
    const dialog = await screen.findByRole("dialog", { name: "Upload contacts" });
    const file = new File([`${headers.join(",")}\nada@example.com,Ada Lovelace\n`], "people.csv", { type: "text/csv" });
    fireEvent.change(within(dialog).getByLabelText("CSV file"), { target: { files: [file] } });
    await within(dialog).findByText("Match columns");
    return dialog;
  }

  it.each([
    ["Name", "full"],
    ["name", "full"],
    ["Full name", "full"],
    ["FULL  NAME", "full"],
    ["full_name", "full"],
    ["Fullname", "full"],
    ["Contact", "full"],
    [" contact name ", "full"],
    ["Contact-Name", "full"],
    ["Customer full name", "full"],
    ["First name", "first"],
    ["first_name", "first"],
    ["Last name", "last"],
    ["Surname", "last"],
    ["Contact email", "email"],
    ["Company name", "skip"],
    ["Contacted", "skip"],
  ])("guessField(%j) is %s", (header, field) => {
    expect(guessField(header)).toBe(field);
  });

  it("a Name column of full names is matched to Full name, not First name, and the dry run and import send it as the full name", async () => {
    state.previewQueue.push(reply(counts({ new: 1 })));
    const dialog = await openWith(["Email", "Name", "Notes"]);
    const name = within(dialog).getByLabelText("Name") as HTMLSelectElement;
    expect(name.value).toBe("full");
    expect(name.selectedOptions[0].textContent).toBe("Full name");
    await waitFor(() => expect(countCalls()).toHaveLength(1));
    expect(countCalls()[0].form).toEqual({ column: "Email", full_column: "Name", list_id: LIST_A.id });
    await waitFor(() => expect(importButton().textContent).toBe("Import 1 contact"));
    fireEvent.click(within(dialog).getByLabelText("These people agreed to get email from Brightloop"));
    fireEvent.click(importButton());
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(calls.find((c) => c.url.endsWith("/import-csv"))!.form).toEqual({ column: "Email", list_id: LIST_A.id, full_column: "Name" });
  });

  it("picking First name for another column takes Full name off, and picking Full name takes First and Last off, so both are never sent", async () => {
    state.previewQueue.push(reply(counts({ new: 1 })), reply(counts({ new: 1 })), reply(counts({ new: 1 })), reply(counts({ new: 1 })));
    const dialog = await openWith(["Email", "Name", "Given", "Family"]);
    await waitFor(() => expect(countCalls()).toHaveLength(1));
    fireEvent.change(within(dialog).getByLabelText("Given"), { target: { value: "first" } });
    expect((within(dialog).getByLabelText("Name") as HTMLSelectElement).value).toBe("skip");
    fireEvent.change(within(dialog).getByLabelText("Family"), { target: { value: "last" } });
    await waitFor(() => expect(countCalls().at(-1)?.form).toEqual({ column: "Email", first_column: "Given", last_column: "Family", list_id: LIST_A.id }));
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "full" } });
    expect((within(dialog).getByLabelText("Given") as HTMLSelectElement).value).toBe("skip");
    expect((within(dialog).getByLabelText("Family") as HTMLSelectElement).value).toBe("skip");
    await waitFor(() => expect(countCalls().at(-1)?.form).toEqual({ column: "Email", full_column: "Name", list_id: LIST_A.id }));
    expect(countCalls().some((c) => c.form?.full_column && (c.form.first_column || c.form.last_column))).toBe(false);
  });

  it("a file with Name, First name and Last name columns keeps First and Last on their own headers and leaves Name unmatched", async () => {
    state.previewQueue.push(reply(counts({ new: 1 })));
    const dialog = await openWith(["Email", "Name", "First name", "Last name"]);
    expect((within(dialog).getByLabelText("Name") as HTMLSelectElement).value).toBe("skip");
    expect((within(dialog).getByLabelText("First name") as HTMLSelectElement).value).toBe("first");
    expect((within(dialog).getByLabelText("Last name") as HTMLSelectElement).value).toBe("last");
    await waitFor(() => expect(countCalls()).toHaveLength(1));
    expect(countCalls()[0].form).toEqual({ column: "Email", first_column: "First name", last_column: "Last name", list_id: LIST_A.id });
  });
});

describe("a slow first file", () => {
  it("never replaces the file picked after it", async () => {
    const slow = deferred();
    const OTHER = { columns: [{ header: "Work email", samples: ["bo@example.com"], has_addresses: true }], auto_column: null, row_count: 2, preview_rows: [["bo@example.com"]] };
    state.baseQueue = [() => slow.promise, () => Promise.resolve(ok(OTHER))];
    render(<EmailContactsSection />);
    await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
    fireEvent.click(screen.getByRole("button", { name: /Upload CSV/ }));
    const dialog = await screen.findByRole("dialog", { name: "Upload contacts" });
    const input = within(dialog).getByLabelText("CSV file");
    fireEvent.change(input, { target: { files: [new File(["Email\nada@example.com\n"], "first.csv", { type: "text/csv" })] } });
    fireEvent.change(input, { target: { files: [new File(["Work email\nbo@example.com\n"], "second.csv", { type: "text/csv" })] } });
    await within(dialog).findByText("Match columns");
    expect(within(dialog).getAllByText("Work email").length).toBeGreaterThan(0);
    await act(async () => slow.resolve(ok(BASE_PREVIEW)));
    await act(async () => {});
    expect(within(dialog).queryByText("Surname")).toBeNull();
    expect(within(dialog).getAllByText("Work email").length).toBeGreaterThan(0);
  });
});

describe("import from database", () => {
  it("a failed column read for one table clears once another table's columns load", async () => {
    render(<EmailContactsSection />);
    await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
    fireEvent.click(screen.getByRole("button", { name: "Import from database" }));
    const dialog = await screen.findByRole("dialog", { name: "Import from database" });
    const tableSelect = await within(dialog).findByLabelText("Table");
    fireEvent.change(tableSelect, { target: { value: "users" } });
    expect(await within(dialog).findByText("Zavi could not read the columns of users.")).toBeTruthy();
    fireEvent.change(tableSelect, { target: { value: "leads" } });
    await waitFor(() => expect((within(dialog).getByLabelText("Email column") as HTMLSelectElement).disabled).toBe(false));
    expect(within(dialog).queryByText("Zavi could not read the columns of users.")).toBeNull();
  });
});

describe("import from database stale choices", () => {
  const NO_EMAIL = "That column has no valid email addresses. Choose the column that holds them.";
  const open = async () => {
    render(<EmailContactsSection />);
    await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
    fireEvent.click(screen.getByRole("button", { name: "Import from database" }));
    const dialog = await screen.findByRole("dialog", { name: "Import from database" });
    const pick = async (table: string) => {
      fireEvent.change(await within(dialog).findByLabelText("Table"), { target: { value: table } });
      await waitFor(() => expect((within(dialog).getByLabelText("Email column") as HTMLSelectElement).disabled).toBe(false));
    };
    const tick = () => within(dialog).getByLabelText("These people agreed to get email from Brightloop") as HTMLInputElement;
    const button = () => within(dialog).getByRole("button", { name: "Import" }) as HTMLButtonElement;
    return { dialog, pick, tick, button };
  };

  it("drops the red line when the column changes, and needs consent again", async () => {
    state.importError = NO_EMAIL;
    const { dialog, pick, tick, button } = await open();
    await pick("plans");
    fireEvent.change(within(dialog).getByLabelText("Email column"), { target: { value: "plan" } });
    fireEvent.click(tick());
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    expect(await within(dialog).findByText(NO_EMAIL)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Email column"), { target: { value: "email" } });
    expect(within(dialog).queryByText(NO_EMAIL)).toBeNull();
    expect(tick().checked).toBe(false);
    expect(button().disabled).toBe(true);
  });

  it("clears consent when the table changes", async () => {
    const { dialog, pick, tick, button } = await open();
    await pick("leads");
    fireEvent.change(within(dialog).getByLabelText("Email column"), { target: { value: "email" } });
    fireEvent.click(tick());
    await waitFor(() => expect(button().disabled).toBe(false));
    await pick("plans");
    fireEvent.change(within(dialog).getByLabelText("Email column"), { target: { value: "email" } });
    expect(tick().checked).toBe(false);
    expect(button().disabled).toBe(true);
  });

  it("drops the red line when only the target list changes and keeps the tick", async () => {
    state.importError = NO_EMAIL;
    const { dialog, pick, tick, button } = await open();
    await pick("leads");
    fireEvent.change(within(dialog).getByLabelText("Email column"), { target: { value: "email" } });
    fireEvent.click(tick());
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    expect(await within(dialog).findByText(NO_EMAIL)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Add to list"), { target: { value: LIST_TEST.id } });
    expect(within(dialog).queryByText(NO_EMAIL)).toBeNull();
    expect(tick().checked).toBe(true);
  });
});

describe("import from database result line", () => {
  const pickColumn = async () => {
    render(<EmailContactsSection />);
    await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
    fireEvent.click(screen.getByRole("button", { name: "Import from database" }));
    const dialog = await screen.findByRole("dialog", { name: "Import from database" });
    fireEvent.change(await within(dialog).findByLabelText("Table"), { target: { value: "leads" } });
    await waitFor(() => expect((within(dialog).getByLabelText("Email column") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(within(dialog).getByLabelText("Email column"), { target: { value: "email" } });
    fireEvent.click(within(dialog).getByLabelText("These people agreed to get email from Brightloop"));
    const button = within(dialog).getByRole("button", { name: "Import" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    return dialog;
  };

  it("says how many rows had no valid email next to the erased skip", async () => {
    state.importBody = { list_id: "L-NEW", version_id: "V-NEW", added: 4, invalid: 2, duplicates: 0, over_limit: 0, already_unsubscribed: 0, skipped_erased: 1 };
    await pickColumn();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(toastSpy.mock.calls[0][0]).toMatchObject({
      title: `Imported 4 contacts into ${LIST_A.name}. Skipped 2 rows with no valid email. Skipped 1 erased contact.`,
    });
  });

  it("says so when every row was dropped, not just that nothing was imported", async () => {
    state.importBody = { list_id: null, version_id: null, added: 0, invalid: 1, duplicates: 0, over_limit: 0, already_unsubscribed: 0, skipped_erased: 0 };
    await pickColumn();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(toastSpy.mock.calls[0][0]).toMatchObject({ title: `Skipped 1 row with no valid email. Nothing was imported into ${LIST_A.name}.` });
  });

  it("shows the hint under the dialog text", async () => {
    render(<EmailContactsSection />);
    await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
    fireEvent.click(screen.getByRole("button", { name: "Import from database" }));
    const dialog = await screen.findByRole("dialog", { name: "Import from database" });
    expect(within(dialog).getByText(/Empty values and bad addresses are skipped\./)).toBeTruthy();
  });
});

describe("an email card's Make the list from your database", () => {
  it("opens the database import when the section mounts after the request, and when it is already on screen", async () => {
    const nav = await import("../emailSettingsNav");
    state.role = "owner";
    nav.requestDatabaseImport();
    const { unmount } = render(<EmailContactsSection />);
    expect(await screen.findByRole("dialog", { name: "Import from database" })).toBeTruthy();
    unmount();
    render(<EmailContactsSection />);
    await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => nav.requestDatabaseImport());
    expect(await screen.findByRole("dialog", { name: "Import from database" })).toBeTruthy();
  });
});
