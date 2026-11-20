// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Resp = { status: number; body: unknown };
const h = vi.hoisted(() => ({
  paths: [] as string[],
  respond: (_path: string): { status: number; body: unknown } => ({ status: 200, body: { rows: [], next_before: null } }),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) => {
    h.paths.push(path);
    const r: Resp = h.respond(path);
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
  },
}));

import { agentDisplayName } from "@/lib/agentRegistry";
import { DataAccessTab } from "./DataAccessTab";

const RUN = "77777777-7777-4777-8777-777777777777";
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

function row(id: string, extra: Record<string, unknown>) {
  return {
    id,
    created_at: iso(60_000 * 5),
    finished_at: iso(60_000 * 5),
    caller_kind: "agent",
    agent_slug: "growth-lead",
    feature: null,
    run_id: RUN,
    tool_name: "operator_db__codeact",
    mode: "direct",
    dialect: "postgres",
    operation: "read",
    query_text: "select count(*)\nfrom bookings",
    tables: ["bookings"],
    row_count: 12,
    sent_to_ai: true,
    result: "allowed",
    refused_by: null,
    reason: null,
    totals_only: false,
    ms: 40,
    ...extra,
  };
}

const ROWS = [
  row("11111111-1111-4111-8111-111111111111", {}),
  row("22222222-2222-4222-8222-222222222222", {
    mode: "connector",
    result: "refused",
    refused_by: "connector",
    reason: "email is blocked",
    row_count: 0,
    sent_to_ai: false,
    query_text: "select email from users",
    tables: ["users"],
  }),
  row("33333333-3333-4333-8333-333333333333", { result: "refused", refused_by: "zavi", reason: "users is switched off", sent_to_ai: false }),
  row("44444444-4444-4444-8444-444444444444", { result: "failed", sent_to_ai: false }),
  row("55555555-5555-4555-8555-555555555555", { result: "pending", finished_at: null, created_at: iso(5 * 60_000), sent_to_ai: false }),
  row("66666666-6666-4666-8666-666666666666", {
    caller_kind: "background",
    agent_slug: null,
    feature: "Schema discovery",
    run_id: null,
    operation: "structure_scan",
    sent_to_ai: false,
  }),
  row("88888888-8888-4888-8888-888888888888", { caller_kind: "person", agent_slug: null, feature: "Contact import", run_id: null, sent_to_ai: false }),
];

beforeEach(() => {
  h.paths = [];
  h.respond = () => ({ status: 200, body: { rows: ROWS, next_before: null } });
});
afterEach(() => cleanup());

describe("DataAccessTab", () => {
  it("lists every query with who ran it, the setup and the result", async () => {
    render(<DataAccessTab />);
    await screen.findByText("Refused by your connector");
    expect(h.paths[0]).toMatch(/^\/api\/connectors\/operator-db\/access-log\?/);
    expect(h.paths[0]).toContain("days=30");
    expect(screen.getByRole("heading", { name: "Data access" })).toBeDefined();
    const table = within(screen.getByRole("table"));
    expect(table.getAllByText(agentDisplayName("growth-lead")).length).toBeGreaterThan(0);
    expect(table.getByText("Zavi (background) · Schema discovery")).toBeDefined();
    expect(table.getByText("Contact import")).toBeDefined();
    expect(table.getAllByText("Quick setup").length).toBeGreaterThan(0);
    expect(table.getAllByText("Your server").length).toBeGreaterThan(0);
    expect(table.getAllByText("Allowed").length).toBeGreaterThan(0);
    expect(table.getByText("email is blocked")).toBeDefined();
    expect(table.getByText("Refused by a data-access rule")).toBeDefined();
    expect(table.getByText("Failed")).toBeDefined();
    expect(table.getByText("Unfinished")).toBeDefined();
  });

  it("a recent pending row reads as Running, not Unfinished", async () => {
    h.respond = () => ({
      status: 200,
      body: { rows: [row("99999999-9999-4999-8999-999999999999", { result: "pending", created_at: iso(5_000), finished_at: null })], next_before: null },
    });
    render(<DataAccessTab />);
    await screen.findByText("Running");
    expect(within(screen.getByRole("table")).queryByText("Unfinished")).toBeNull();
  });

  it("empty state keeps the table layout with one empty row", async () => {
    h.respond = () => ({ status: 200, body: { rows: [], next_before: null } });
    render(<DataAccessTab />);
    await screen.findByText("No queries yet");
    for (const col of ["Time", "Agent", "Mode", "Query", "Rows", "Sent to AI", "Result"]) {
      expect(screen.getByRole("columnheader", { name: col })).toBeDefined();
    }
  });

  it("clicking a row shows the full query, its tables and a run link", async () => {
    render(<DataAccessTab />);
    await screen.findByText("email is blocked");
    expect(screen.queryByText(/Full query/)).toBeNull();
    fireEvent.click(screen.getByText("select email from users"));
    const detail = await screen.findByTestId("data-access-detail");
    expect(within(detail).getByText(/Full query/)).toBeDefined();
    expect(detail.textContent).toContain("· users");
    expect(within(detail).getByRole("link", { name: "Open run" }).getAttribute("href")).toBe(`/workspace?tab=run&run=${RUN}`);
    expect(detail.textContent).toContain("select email from users");
  });

  it("a deep link loads that entry, expands it and scrolls to it", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<DataAccessTab entryId={id} />);
    const detail = await screen.findByTestId("data-access-detail");
    expect(detail.textContent).toContain("select email from users");
    expect(h.paths.some((p) => p.includes(`id=${id}`))).toBe(true);
    await waitFor(() => expect(scroll).toHaveBeenCalled());
  });

  it("a deep link to an entry outside the window is fetched by id and shown first", async () => {
    const old = row("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { query_text: "select 42 as old_one" });
    h.respond = (p) => (p.includes("id=") ? { status: 200, body: { rows: [old], next_before: null } } : { status: 200, body: { rows: ROWS, next_before: null } });
    Element.prototype.scrollIntoView = vi.fn();
    render(<DataAccessTab entryId={old.id} />);
    const detail = await screen.findByTestId("data-access-detail");
    expect(detail.textContent).toContain("select 42 as old_one");
  });

  it("a junk deep-link id is ignored", async () => {
    render(<DataAccessTab entryId="../../x" />);
    await screen.findByText("email is blocked");
    expect(h.paths.some((p) => p.includes("id="))).toBe(false);
  });

  it("filters refetch with the chosen values", async () => {
    render(<DataAccessTab />);
    await screen.findByText("email is blocked");
    fireEvent.change(screen.getByLabelText("Setup"), { target: { value: "connector" } });
    await waitFor(() => expect(h.paths.at(-1)).toContain("mode=connector"));
    fireEvent.change(screen.getByLabelText("Result"), { target: { value: "refused" } });
    await waitFor(() => expect(h.paths.at(-1)).toContain("result=refused"));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "7" } });
    await waitFor(() => expect(h.paths.at(-1)).toContain("days=7"));
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "background" } });
    await waitFor(() => expect(h.paths.at(-1)).toContain("agent=background"));
  });

  it("a 403 says the log is for owners and admins", async () => {
    h.respond = () => ({ status: 403, body: { error: { code: "not_admin" } } });
    render(<DataAccessTab />);
    await screen.findByText("Only owners and admins can see the data access log.");
  });

  it("Load more asks for the next page", async () => {
    h.respond = (p) =>
      p.includes("before=")
        ? { status: 200, body: { rows: [row("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { query_text: "select 'page two'" })], next_before: null } }
        : { status: 200, body: { rows: ROWS, next_before: ROWS[ROWS.length - 1].created_at, next_before_id: ROWS[ROWS.length - 1].id } };
    render(<DataAccessTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await screen.findByText("select 'page two'");
    const more = h.paths.find((x) => x.includes("before="))!;
    expect(more).toContain(`before_id=${ROWS[ROWS.length - 1].id}`);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("a deep link is fetched by id alone, whatever the list filters are", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    Element.prototype.scrollIntoView = vi.fn();
    render(<DataAccessTab entryId={id} />);
    await screen.findByTestId("data-access-detail");
    fireEvent.change(screen.getByLabelText("Result"), { target: { value: "failed" } });
    await waitFor(() => expect(h.paths.at(-2) ?? "").toBeTruthy());
    const byId = h.paths.filter((x) => x.includes(`id=${id}`));
    expect(byId.length).toBeGreaterThan(0);
    for (const x of byId) expect(x).not.toMatch(/result=|mode=|agent=|days=/);
  });

  it("switching ?access from A to B while mounted expands B", async () => {
    const a = "22222222-2222-4222-8222-222222222222";
    const b = ROWS.find((r) => r.id !== a)!;
    Element.prototype.scrollIntoView = vi.fn();
    const { rerender } = render(<DataAccessTab entryId={a} />);
    await screen.findByTestId("data-access-detail");
    rerender(<DataAccessTab entryId={b.id} />);
    await waitFor(() => expect(screen.getByTestId("data-access-detail").textContent).toContain(b.query_text as string));
  });
});
