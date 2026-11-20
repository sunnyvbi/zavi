// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const EMAIL = "zavi-email-qa-3@yopmail.com";
const LIST = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Newsletter",
  created_at: "2026-10-01T00:00:00Z",
  latest: { id: "v-a", source_kind: "csv", source_label: "Email", contact_count: 3, created_at: "2026-10-01T00:00:00Z", consented: true },
  active: { id: "v-a", contact_count: 3, sendable: 3, unsubscribed_or_bounced: 0 },
  needs_consent: false,
};

const server = vi.hoisted(() => ({ suppressed: new Set<string>(), calls: [] as Array<{ method: string; url: string }>, gate: null as Promise<void> | null }));

function reply(method: string, url: string, body: unknown) {
  if (url === "/api/workspace/email-lists" && method === "GET") return { lists: [LIST] };
  if (url.startsWith("/api/workspace/email-contacts?")) {
    const off = server.suppressed.has(EMAIL);
    return {
      rows: [
        {
          id: "p-3",
          email: EMAIL,
          masked: false,
          name: null,
          lists: [{ id: LIST.id, name: LIST.name }],
          status: off ? "suppressed" : "ok",
          source: "csv",
          added_at: "2026-10-01T00:00:00Z",
        },
      ],
      total: 1,
      counts: { contacts: 3, lists: 1, unsubscribed: off ? 1 : 0, bounced: 0 },
      masked: false,
    };
  }
  if (url === "/api/workspace/email-test-lists") return { routes: [], orphans: [] };
  if (url.startsWith("/api/workspace/email-suppressions?")) {
    return {
      rows: [...server.suppressed].map((email) => ({ email, reason: "manual", created_at: "2026-10-26T00:00:00Z" })),
      total: server.suppressed.size,
      page: 1,
      page_size: 50,
      masked: false,
    };
  }
  if (url === "/api/workspace/email-suppressions" && method === "POST") {
    const email = (body as { email: string }).email;
    server.suppressed.add(email);
    return { added: true, email, reason: "manual", created_at: "2026-10-26T00:00:00Z" };
  }
  return {};
}

vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? "GET";
    server.calls.push({ method, url });
    if (method === "POST" && server.gate) await server.gate;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const r = reply(method, url, body);
    return { ok: true, status: 200, json: () => Promise.resolve(r) };
  },
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner", tenantName: "Brightloop" }) }));

import { EmailContactsSection } from "../EmailContactsSection";

const rowsFor = (cells: number) =>
  screen
    .queryAllByText(EMAIL)
    .map((el) => el.closest("tr"))
    .filter((tr): tr is HTMLTableRowElement => !!tr && tr.querySelectorAll("td").length === cells);
const personStatus = () => rowsFor(6)[0]?.querySelectorAll("td")[2]?.textContent ?? null;
const peopleGets = () => server.calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/workspace/email-contacts?")).length;

beforeEach(() => {
  server.suppressed.clear();
  server.calls.length = 0;
  server.gate = null;
});
afterEach(cleanup);

describe("Never email from the Suppressed tab", () => {
  it("adding a person who is in People flips their People row to Suppressed and refreshes the stats, without a remount", async () => {
    render(<EmailContactsSection />);
    await waitFor(() => expect(personStatus()).toBe("Subscribed"));
    expect(screen.getByTestId("stat-unsubscribed").textContent).toBe("0");
    const before = peopleGets();

    fireEvent.click(screen.getByRole("button", { name: "Suppressed" }));
    await screen.findByText("No suppressed addresses yet.", { selector: "td" });
    fireEvent.change(screen.getByLabelText("Never email"), { target: { value: EMAIL } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByText(`Added. Zavi's own sender will not email ${EMAIL}. Campaigns sent through SendGrid, Mailchimp or Klaviyo follow that tool's own unsubscribe list, so add the address there too.`);
    await waitFor(() => expect(rowsFor(3)).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "People" }));
    await waitFor(() => expect(personStatus()).toBe("Suppressed"));
    expect(screen.getByTestId("stat-unsubscribed").textContent).toBe("1");

    const post = server.calls.findIndex((c) => c.method === "POST" && c.url === "/api/workspace/email-suppressions");
    expect(post).toBeGreaterThan(-1);
    expect(server.calls.slice(post + 1).some((c) => c.method === "GET" && c.url.startsWith("/api/workspace/email-contacts?"))).toBe(true);
    expect(peopleGets()).toBe(before + 1);
    expect(within(screen.getByRole("group", { name: "Contacts view" })).getByRole("button", { name: "People" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Enter in the Never email field", () => {
  const posts = () => server.calls.filter((c) => c.method === "POST" && c.url === "/api/workspace/email-suppressions").length;
  const open = async () => {
    render(<EmailContactsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Suppressed" }));
    await screen.findByText("No suppressed addresses yet.", { selector: "td" });
    return screen.getByLabelText("Never email") as HTMLInputElement;
  };

  it("adds the address once, even when Enter is pressed again while the add is in flight", async () => {
    let release = () => {};
    server.gate = new Promise<void>((r) => (release = r));
    const field = await open();
    fireEvent.change(field, { target: { value: `  ${EMAIL} ` } });
    expect(fireEvent.keyDown(field, { key: "Enter", code: "Enter" })).toBe(false);
    fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Adding…" })).toBeDefined());
    fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
    expect(posts()).toBe(1);
    release();
    await screen.findByText(`Added. Zavi's own sender will not email ${EMAIL}. Campaigns sent through SendGrid, Mailchimp or Klaviyo follow that tool's own unsubscribe list, so add the address there too.`);
    await waitFor(() => expect(rowsFor(3)).toHaveLength(1));
    expect(field.value).toBe("");
    fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
    await new Promise((r) => setTimeout(r, 20));
    expect(posts()).toBe(1);
  });

  it.each([["empty", ""], ["spaces", "   "], ["not an address", "not-an-email"], ["no domain", "name@"]])("%s sends nothing", async (_name, value) => {
    const field = await open();
    fireEvent.change(field, { target: { value } });
    fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
    await new Promise((r) => setTimeout(r, 20));
    expect(posts()).toBe(0);
    expect(screen.queryByText(/Added\. Zavi's own sender will not email/)).toBeNull();
  });

  it("other keys and Enter while composing text send nothing", async () => {
    const field = await open();
    fireEvent.change(field, { target: { value: EMAIL } });
    fireEvent.keyDown(field, { key: "a" });
    fireEvent.keyDown(field, { key: "Enter", code: "Enter", isComposing: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(posts()).toBe(0);
  });
});
