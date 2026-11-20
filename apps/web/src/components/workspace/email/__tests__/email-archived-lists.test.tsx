// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Reply = { status: number; body: unknown };
type Handler = Reply | (() => Reply | Promise<Reply>);
const calls: Array<{ url: string; method: string }> = [];
const routes: Record<string, Handler> = {};
const ws = vi.hoisted(() => ({ role: "owner" as string | null }));

vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const h = routes[`${method} ${url}`] ?? (url.startsWith("/api/workspace/email-contacts?") ? routes["GET /api/workspace/email-contacts"] : undefined);
    const r = typeof h === "function" ? await h() : (h ?? { status: 200, body: {} });
    return { ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) };
  },
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: ws.role, tenantName: "Brightloop" }) }));

import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";
import { EmailContactsSection } from "../EmailContactsSection";

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const LISTS = "GET /api/workspace/email-lists";
const ARCHIVED = "GET /api/workspace/email-lists/archived";
const UNARCHIVE = `POST /api/workspace/email-lists/${ID}/unarchive`;
const row = (over: Record<string, unknown> = {}) => ({ id: ID, name: "Spring leads", archived_at: "2026-11-01T00:00:00Z", people: 1240, members_hidden: false, ...over });
const active = { id: ID, name: "Spring leads", created_at: "2026-10-07T00:00:00Z", latest: null, active: null, needs_consent: false };
const ok = (body: unknown): Reply => ({ status: 200, body });
const count = (key: string) => calls.filter((c) => `${c.method} ${c.url}` === key).length;

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  ws.role = "owner";
  routes[LISTS] = ok({ lists: [] });
  routes[ARCHIVED] = ok({ lists: [row()] });
  routes["GET /api/workspace/email-contacts"] = ok({ rows: [], total: 0, counts: { contacts: 3, lists: 1, unsubscribed: 0, bounced: 0 }, masked: false });
  routes["GET /api/workspace/email-test-lists"] = ok({ routes: [], orphans: [] });
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

const header = () => screen.getByTestId("email-contacts-actions");

async function openArchived() {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Archived lists" }));
  return screen.findByRole("dialog", { name: "Archived lists" });
}

async function confirmUnarchive(name = "Spring leads") {
  fireEvent.click(await screen.findByRole("button", { name: `Unarchive ${name}` }));
  const dialog = await screen.findByRole("alertdialog", { name: `Unarchive "${name}"?` });
  fireEvent.click(within(dialog).getByRole("button", { name: "Unarchive list" }));
}

describe("Archived lists button", () => {
  it("sits with the header buttons and is absent while nothing is archived", async () => {
    routes[ARCHIVED] = ok({ lists: [] });
    mount();
    await screen.findByRole("button", { name: "Upload CSV" });
    await waitFor(() => expect(count(ARCHIVED)).toBe(1));
    expect(screen.queryByRole("button", { name: "Archived lists" })).toBeNull();
  });

  it("is a matching secondary button in the header, and takes its own full row in the two-column phone grid", async () => {
    mount();
    const button = await within(header()).findByRole("button", { name: "Archived lists" });
    const upload = within(header()).getByRole("button", { name: "Upload CSV" });
    for (const c of upload.className.split(/\s+/)) expect(button.className.split(/\s+/)).toContain(c);
    expect(button.className).toContain("compact:col-span-2");
    expect(button.className).toContain("[@container(max-width:640px)]:col-span-2");
  });

  it("a failed read leaves the rest of Contacts working and shows no button", async () => {
    routes[ARCHIVED] = { status: 500, body: { error: { code: "boom", message: "No." } } };
    mount();
    await screen.findByRole("button", { name: "Upload CSV" });
    await waitFor(() => expect(count(ARCHIVED)).toBe(1));
    expect(screen.queryByRole("button", { name: "Archived lists" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("appears as soon as a list is archived, without leaving the page", async () => {
    let done = false;
    routes[LISTS] = () => ok({ lists: done ? [] : [active] });
    routes[ARCHIVED] = () => ok({ lists: done ? [row()] : [] });
    routes[`DELETE /api/workspace/email-lists/${ID}`] = () => {
      done = true;
      return ok({ ok: true });
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^Lists/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Archive Spring leads" }));
    const dialog = await screen.findByRole("alertdialog", { name: 'Archive "Spring leads"?' });
    expect(dialog.textContent).toContain("You can bring it back from Archived lists.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive list" }));
    expect(await screen.findByRole("button", { name: "Archived lists" })).toBeTruthy();
  });
});

describe("Archived lists dialog", () => {
  it("shows each list with its people count", async () => {
    routes[ARCHIVED] = ok({ lists: [row(), row({ id: ID2, name: "Old", people: 1 })] });
    const dialog = await openArchived();
    const rows = within(dialog).getAllByTestId("archived-list-row");
    expect(rows[0].textContent).toContain("Spring leads");
    expect(rows[0].textContent).toContain("1,240 people");
    expect(rows[1].textContent).toContain("1 person");
  });

  it("a member sees the lists and no Unarchive, and a withheld count stays withheld", async () => {
    ws.role = "member";
    routes[ARCHIVED] = ok({ lists: [row({ people: null, members_hidden: true })] });
    const dialog = await openArchived();
    expect(dialog.textContent).toContain("Only an owner or admin can see who is on this list.");
    expect(within(dialog).queryByRole("button", { name: /Unarchive/ })).toBeNull();
  });

  it("the confirm says plainly what happens, and Cancel changes nothing", async () => {
    await openArchived();
    fireEvent.click(await screen.findByRole("button", { name: "Unarchive Spring leads" }));
    const dialog = await screen.findByRole("alertdialog", { name: 'Unarchive "Spring leads"?' });
    expect(dialog.textContent).toContain("goes back to Lists and can be picked for sending again");
    expect(dialog.textContent).toContain("Nothing is sent by itself");
    expect(dialog.textContent).toContain("Unsubscribed, bounced and suppressed people stay off every send");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(count(UNARCHIVE)).toBe(0);
  });

  it("confirming returns the list, reloads Lists, tells the founder, and drops the button with the last archived list", async () => {
    let back = false;
    routes[LISTS] = () => ok({ lists: back ? [active] : [] });
    routes[ARCHIVED] = () => ok({ lists: back ? [] : [row()] });
    routes[UNARCHIVE] = () => {
      back = true;
      return ok({ ok: true, unarchived: true, stopped_sends: 0 });
    };
    await openArchived();
    await confirmUnarchive();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Archived lists" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Archived lists" })).toBeNull();
    expect((await screen.findByRole("status")).textContent).toContain("Spring leads is back in Lists and can be picked for sending again.");
    expect(count(LISTS)).toBeGreaterThanOrEqual(2);
    expect(count(UNARCHIVE)).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /^Lists/ }));
    expect(await screen.findByRole("button", { name: "Archive Spring leads" })).toBeTruthy();
  });

  it("the dialog stays open on the lists still archived", async () => {
    let back = false;
    const other = row({ id: ID2, name: "Old" });
    routes[ARCHIVED] = () => ok({ lists: back ? [other] : [row(), other] });
    routes[UNARCHIVE] = () => {
      back = true;
      return ok({ ok: true, unarchived: true, stopped_sends: 0 });
    };
    const dialog = await openArchived();
    await confirmUnarchive();
    await waitFor(() => expect(within(dialog).getAllByTestId("archived-list-row")).toHaveLength(1));
    expect(within(dialog).getByRole("button", { name: "Unarchive Old" })).toBeTruthy();
  });

  it.each([
    [1, "The send the archive stopped stays stopped."],
    [2, "The 2 sends the archive stopped stay stopped."],
  ])("with %i stopped sends the founder is told they do not restart", async (stopped, line) => {
    routes[UNARCHIVE] = () => {
      routes[ARCHIVED] = ok({ lists: [] });
      return ok({ ok: true, unarchived: true, stopped_sends: stopped });
    };
    await openArchived();
    await confirmUnarchive();
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain(line);
    expect(status.textContent).toContain("approve a new email");
  });

  it("a list another tab already brought back reads as already there, not as an error", async () => {
    routes[UNARCHIVE] = () => {
      routes[ARCHIVED] = ok({ lists: [] });
      return ok({ ok: true, unarchived: false, stopped_sends: 0 });
    };
    await openArchived();
    await confirmUnarchive();
    expect((await screen.findByRole("status")).textContent).toBe("Spring leads is already in Lists.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a name refusal shows in the dialog, keeps the list there, and lets the founder try again", async () => {
    routes[UNARCHIVE] = { status: 409, body: { error: { code: "name_taken", message: "Another list already uses this name. Archive that list first, then unarchive this one." } } };
    const dialog = await openArchived();
    await confirmUnarchive();
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Archive that list first");
    expect(within(dialog).getByTestId("archived-list-row").textContent).toContain("Spring leads");
    expect((within(dialog).getByRole("button", { name: "Unarchive Spring leads" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a double click while the request is out sends one request", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    routes[UNARCHIVE] = async () => {
      await held;
      routes[ARCHIVED] = ok({ lists: [] });
      return ok({ ok: true, unarchived: true, stopped_sends: 0 });
    };
    await openArchived();
    await confirmUnarchive();
    const busy = await screen.findByRole("button", { name: /Unarchiving/ });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busy);
    release();
    await screen.findByRole("status");
    expect(count(UNARCHIVE)).toBe(1);
  });
});
