// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const server = vi.hoisted(() => ({
  people: [] as Array<{ id: string; email: string; name: string | null }>,
  refusal: null as null | { status: number; body: unknown },
  gate: null as Promise<void> | null,
  deletes: [] as string[],
  role: "owner" as string | null,
  networkDown: false,
  gone: new Set<string>(),
}));

const page = (url: string) => {
  const q = new URL(url, "http://x").searchParams;
  const offset = Number(q.get("offset") ?? 0);
  const limit = Number(q.get("limit") ?? 50);
  const search = q.get("search") ?? "";
  const hit = server.people.filter((p) => p.email.includes(search));
  const rows = hit.slice(offset, offset + limit).map((p) => ({
    ...p,
    masked: false,
    lists: [{ id: "L1", name: "Newsletter" }],
    status: "ok",
    source: "csv",
    added_at: "2026-10-01T00:00:00Z",
  }));
  const counts = !search && offset === 0 ? { contacts: server.people.length, lists: 1, unsubscribed: 0, bounced: 0 } : null;
  return { rows, total: hit.length, counts, masked: false };
};

const list = () => {
  const n = server.people.length;
  return {
    id: "L1",
    name: "Newsletter",
    created_at: "2026-10-01T00:00:00Z",
    latest: { id: "v1", source_kind: "csv", source_label: "Email", contact_count: n, created_at: "2026-10-01T00:00:00Z", consented: true },
    active: { id: "v1", contact_count: n, sendable: n, unsubscribed_or_bounced: 0 },
    needs_consent: false,
  };
};

vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: () => Promise.resolve(body) });
    if (method === "DELETE") {
      server.deletes.push(url);
      if (server.gate) await server.gate;
      if (server.networkDown) throw new Error("offline");
      if (server.refusal) {
        if (server.refusal.status === 404) server.people = server.people.filter((p) => !url.endsWith(p.id));
        return json(server.refusal.status, server.refusal.body);
      }
      server.people = server.people.filter((p) => !url.endsWith(p.id));
      return json(200, { ok: true });
    }
    if (url.startsWith("/api/workspace/email-contacts?")) return json(200, page(url));
    if (url === "/api/workspace/email-lists") return json(200, { lists: [list()] });
    if (url === "/api/workspace/email-lists/archived") return json(200, { lists: [] });
    if (url === "/api/workspace/email-test-lists") return json(200, { routes: [], orphans: [] });
    return json(200, {});
  },
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: server.role, tenantName: "Brightloop" }) }));

import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/toast";
import { EmailContactsSection } from "../EmailContactsSection";

const ADA = { id: "11111111-1111-4111-8111-111111111111", email: "ada@example.com", name: "Ada Lovelace" };
const BO = { id: "22222222-2222-4222-8222-222222222222", email: "bo@example.com", name: null };
const REFUSED = { error: { code: "not_authorized", message: "You do not have permission to do that." } };

const mount = () =>
  render(
    <>
      <ConfirmDialogHost />
      <EmailContactsSection />
    </>,
  );
const table = () => screen.getByRole("table");
const eraseIn = (scope: HTMLElement, who: string) => within(scope).findByRole("button", { name: `Erase ${who}` });
const eraseRow = async (who: string) => eraseIn(await screen.findByRole("table"), who);
const stat = (n: string) => screen.getByTestId(`stat-${n}`).textContent;
const confirmDialog = () => screen.findByRole("alertdialog").catch(() => screen.findByRole("dialog"));
const confirmButton = async () => within(await confirmDialog()).findByRole("button", { name: "Erase" });
const inTable = (text: string) => within(table()).queryByText(text, { selector: "td" });
const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 15)));

let toastSpy: MockInstance<Parameters<typeof toast.add>, ReturnType<typeof toast.add>>;
beforeEach(() => {
  toastSpy = vi.spyOn(toast, "add").mockReturnValue("t");
  server.people = [ADA, BO];
  server.refusal = null;
  server.gate = null;
  server.deletes.length = 0;
  server.role = "owner";
  server.networkDown = false;
});
afterEach(() => {
  cleanup();
  toastSpy.mockRestore();
});

describe("erasing a person", () => {
  it("the dialog says plainly it cannot be undone and they will not be emailed, and nothing goes out until confirmed", async () => {
    mount();
    fireEvent.click(await eraseRow("Ada Lovelace"));
    const dialog = await confirmDialog();
    expect(within(dialog).getByText("Erase Ada Lovelace?")).toBeTruthy();
    const text = dialog.textContent ?? "";
    expect(text).toContain("This cannot be undone.");
    expect(text).toContain("Zavi will not email them again");
    expect(text).toContain("may still arrive");
    expect(text).toContain("SendGrid, Mailchimp or Klaviyo");
    expect(server.deletes).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await flush();
    expect(server.deletes).toEqual([]);
    expect(toastSpy).not.toHaveBeenCalled();
    expect(inTable("ada@example.com")).not.toBeNull();
  });

  it("success: the row goes, Contacts and the list's count drop, the toast says exactly Erased", async () => {
    mount();
    await waitFor(() => expect(stat("contacts")).toBe("2"));
    fireEvent.click(await eraseRow("Ada Lovelace"));
    fireEvent.click(await confirmButton());
    await waitFor(() => expect(inTable("ada@example.com")).toBeNull());
    await waitFor(() => expect(stat("contacts")).toBe("1"));
    expect(server.deletes).toEqual([`/api/workspace/email-contacts/${ADA.id}`]);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy.mock.calls[0][0]).toMatchObject({ type: "success", title: "Erased" });
    expect(inTable("bo@example.com")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Lists" }));
    await waitFor(() => expect(screen.getByTestId("list-card-count").textContent).toBe("1 person"));
  });

  it("a double click opens one dialog and sends one request; clicks while it runs add nothing, on any row", async () => {
    let release = () => {};
    server.gate = new Promise<void>((r) => (release = r));
    mount();
    const button = await eraseRow("Ada Lovelace");
    act(() => {
      button.click();
      button.click();
    });
    await flush();
    expect(screen.getAllByRole("button", { name: "Erase", hidden: false }).filter((b) => b.closest("[role=dialog],[role=alertdialog]"))).toHaveLength(1);
    const confirm = await confirmButton();
    act(() => {
      confirm.click();
      confirm.click();
    });
    await waitFor(() => expect(server.deletes).toHaveLength(1));
    const running = await within(table()).findByRole("button", { name: /^Erasing… / });
    expect((running as HTMLButtonElement).disabled).toBe(true);
    const other = await eraseRow("bo@example.com");
    expect((other as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(running);
    fireEvent.click(other);
    await flush();
    expect(server.deletes).toHaveLength(1);
    release();
    await waitFor(() => expect(inTable("ada@example.com")).toBeNull());
    await flush();
    expect(server.deletes).toHaveLength(1);
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });

  it("a server refusal keeps the row and the counts, says why, shows no success, and the same row can be tried again", async () => {
    server.refusal = { status: 403, body: REFUSED };
    mount();
    await waitFor(() => expect(stat("contacts")).toBe("2"));
    fireEvent.click(await eraseRow("Ada Lovelace"));
    fireEvent.click(await confirmButton());
    expect((await screen.findByRole("alert")).textContent).toBe("You do not have permission to do that.");
    expect(inTable("ada@example.com")).not.toBeNull();
    expect(stat("contacts")).toBe("2");
    expect(toastSpy).not.toHaveBeenCalled();

    server.refusal = null;
    const retry = await eraseRow("Ada Lovelace");
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(retry);
    fireEvent.click(await confirmButton());
    await waitFor(() => expect(inTable("ada@example.com")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });

  it("no connection keeps the row and says so", async () => {
    server.networkDown = true;
    mount();
    fireEvent.click(await eraseRow("Ada Lovelace"));
    fireEvent.click(await confirmButton());
    expect((await screen.findByRole("alert")).textContent).toContain("We could not reach Zavi");
    expect(inTable("ada@example.com")).not.toBeNull();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("a person already gone (erased in another tab, or the reply was lost): the stale row leaves and no success is claimed", async () => {
    server.refusal = { status: 404, body: { error: { code: "contact_not_found", message: "That contact was not found." } } };
    mount();
    await waitFor(() => expect(stat("contacts")).toBe("2"));
    fireEvent.click(await eraseRow("Ada Lovelace"));
    fireEvent.click(await confirmButton());
    expect((await screen.findByRole("alert")).textContent).toBe("That contact was not found.");
    await waitFor(() => expect(inTable("ada@example.com")).toBeNull());
    await waitFor(() => expect(stat("contacts")).toBe("1"));
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("erasing from a search still updates the Contacts count, which a search reply does not carry", async () => {
    mount();
    await waitFor(() => expect(stat("contacts")).toBe("2"));
    fireEvent.change(screen.getByLabelText("Search contacts"), { target: { value: "bo@" } });
    await waitFor(() => expect(inTable("ada@example.com")).toBeNull(), { timeout: 4000 });
    fireEvent.click(await eraseRow("bo@example.com"));
    fireEvent.click(await confirmButton());
    await waitFor(() => expect(stat("contacts")).toBe("1"));
    expect(within(table()).getByText("No one matches.")).toBeTruthy();
  });

  it("erasing the only person on page 2 lands on page 1 and the count drops", async () => {
    server.people = Array.from({ length: 11 }, (_, i) => ({ id: `id-${i}`, email: `p${String(i).padStart(2, "0")}@x.test`, name: null }));
    mount();
    await waitFor(() => expect(stat("contacts")).toBe("11"));
    fireEvent.click(await screen.findByRole("button", { name: /next/i }));
    fireEvent.click(await eraseRow("p10@x.test"));
    fireEvent.click(await confirmButton());
    await waitFor(() => expect(stat("contacts")).toBe("10"));
    await waitFor(() => expect(inTable("p00@x.test")).not.toBeNull());
  });
});

describe("who can erase", () => {
  it.each([
    ["owner", true],
    ["admin", true],
    ["member", false],
    ["viewer", false],
    [null, false],
  ])("role %s: Erase shown in both layouts: %s", async (role, shown) => {
    server.role = role;
    mount();
    await screen.findByRole("table");
    await waitFor(() => expect(inTable("ada@example.com")).not.toBeNull());
    expect(within(table()).queryAllByRole("button", { name: /^Erase/ }).length > 0).toBe(shown);
    expect(within(screen.getByRole("list", { name: "People" })).queryAllByRole("button", { name: /^Erase/ }).length > 0).toBe(shown);
    expect(within(table()).getAllByRole("row")[1].querySelectorAll("td").length).toBe(within(table()).getAllByRole("columnheader").length);
  });
});

describe("wide table", () => {
  it("the Erase cell and its header stay pinned to the right edge so sideways scrolling never hides the action", async () => {
    mount();
    await screen.findByRole("table");
    await waitFor(() => expect(inTable("ada@example.com")).not.toBeNull());
    const cell = within(table()).getAllByRole("button", { name: /^Erase/ })[0].closest("td")!;
    expect(cell.className).toContain("sticky");
    expect(cell.className).toContain("right-0");
    expect(cell.className).toContain("bg-white");
    const header = within(table()).getAllByRole("columnheader").at(-1)!;
    expect(header.className).toContain("sticky");
    expect(header.className).toContain("right-0");
  });
});

describe("at 390px", () => {
  it("the stacked row carries the action at a tappable height, can run it, and cannot push the row sideways", async () => {
    mount();
    const stacked = await screen.findByRole("list", { name: "People" });
    const button = await eraseIn(stacked, "Ada Lovelace");
    expect(button.className).toContain("h-10");
    expect(button.className).toContain("justify-self-start");
    expect(button.closest("[class*='overflow-x']")).toBeNull();
    fireEvent.click(button);
    fireEvent.click(await confirmButton());
    await waitFor(() => expect(within(stacked).queryByText("ada@example.com")).toBeNull());
    expect(server.deletes).toHaveLength(1);
  });
});
