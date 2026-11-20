// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ role: "owner", openTab: vi.fn() }),
}));

import { RowsBrowser } from "./WebsiteConsole";

const TABLE = {
  name: "listings",
  row_estimate: 30,
  columns: [
    { name: "id", type: "uuid", nullable: false, primary_key: true },
    { name: "title", type: "text", nullable: false },
  ],
  primary_key: ["id"],
  writable: true,
};

type Row = { id: string; title: string };

const TITLE_CELL = 0;

function offsetOf(url: string): number {
  return Number(new URL(url, "http://x").searchParams.get("offset"));
}

function wireTable(initial: Row[]) {
  const state = {
    rows: [...initial],
    served: new Map<string, string>(),
    fetchSeq: 0,
    deleteBodies: [] as { key: { id: string }; version: string }[],
    getOffsets: [] as number[],
  };
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (!init || !init.method || init.method === "GET") {
      const offset = offsetOf(url);
      state.getOffsets.push(offset);
      state.fetchSeq += 1;
      const seq = state.fetchSeq;
      const window = state.rows.slice(offset, offset + 25);
      for (const r of window) state.served.set(r.id, `v${seq}-${r.id}`);
      return {
        ok: true,
        json: async () => ({
          connected: true,
          supported: true,
          dialect: "postgres",
          table: TABLE.name,
          columns: TABLE.columns,
          rows: window,
          row_keys: window.map((r) => ({ id: r.id })),
          row_versions: window.map((r) => `v${seq}-${r.id}`),
          has_more: state.rows.length > offset + window.length,
          masked_columns: [],
          writable: true,
        }),
      };
    }
    if (init.method === "DELETE") {
      const body = JSON.parse(String(init.body)) as { key: { id: string }; version: string };
      state.deleteBodies.push(body);
      const idx = state.rows.findIndex((r) => r.id === body.key.id);
      if (idx === -1 || state.served.get(body.key.id) !== body.version) {
        return {
          ok: false,
          json: async () => ({
            error: { message: "This row changed since it was loaded. Refresh and try again." },
          }),
        };
      }
      state.rows.splice(idx, 1);
      state.served.delete(body.key.id);
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({}) };
  });
  return state;
}

function rowTitles(): string[] {
  return Array.from(document.querySelectorAll("tbody tr"))
    .map((tr) => tr.querySelectorAll("td")[TITLE_CELL]?.textContent?.trim() ?? "")
    .filter(Boolean);
}

function claimsTableIsEmpty(): boolean {
  return screen.queryByText("No rows in this table.") !== null;
}

function clickDeleteFor(title: string) {
  const tr = Array.from(document.querySelectorAll("tbody tr")).find(
    (row) => row.querySelectorAll("td")[TITLE_CELL]?.textContent?.trim() === title,
  );
  if (!tr) throw new Error(`no rendered row titled ${title}; have ${JSON.stringify(rowTitles())}`);
  fireEvent.click(tr.querySelector('[aria-label="Delete row"]')!);
}

function clickNext() {
  fireEvent.click(
    Array.from(document.querySelectorAll("button")).find((b) => /Next/.test(b.textContent ?? ""))!,
  );
}

function typeSearch(value: string) {
  fireEvent.change(screen.getByLabelText("Search rows on this page"), { target: { value } });
}

async function settle() {
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 250));
}

beforeEach(() => {
  apiFetch.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RowsBrowser delete path", () => {
  it("filtered delete that drains page 1 steps back instead of claiming the table is empty", async () => {
    const rows: Row[] = Array.from({ length: 30 }, (_, i) => ({
      id: `r${String(i).padStart(2, "0")}`,
      title: i === 29 ? "zebra" : `row ${i}`,
    }));
    const state = wireTable(rows);

    render(<RowsBrowser table={TABLE as never} canWrite />);
    await waitFor(() => expect(rowTitles().length).toBe(25));

    clickNext();
    await waitFor(() => expect(rowTitles().length).toBe(5));

    typeSearch("zebra");
    await waitFor(() => expect(rowTitles()).toEqual(["zebra"]));

    state.rows = state.rows.filter((r) => !["r25", "r26", "r27", "r28"].includes(r.id));

    clickDeleteFor("zebra");
    await settle();

    expect(state.rows.length).toBe(25);
    expect(claimsTableIsEmpty()).toBe(false);
    expect(state.getOffsets[state.getOffsets.length - 1]).toBe(0);

    typeSearch("");
    await waitFor(() => expect(rowTitles().length).toBe(25));
  });

  it("walks back multiple pages when the current page is far past the new end", async () => {
    const rows: Row[] = Array.from({ length: 51 }, (_, i) => ({
      id: `r${String(i).padStart(2, "0")}`,
      title: `row ${i}`,
    }));
    const state = wireTable(rows);

    render(<RowsBrowser table={TABLE as never} canWrite />);
    await waitFor(() => expect(rowTitles().length).toBe(25));

    clickNext();
    await waitFor(() => expect(rowTitles()[0]).toBe("row 25"));
    clickNext();
    await waitFor(() => expect(rowTitles()).toEqual(["row 50"]));

    state.rows = state.rows.filter((r) => Number(r.id.slice(1)) >= 25);

    clickDeleteFor("row 50");
    await settle();

    expect(state.rows.length).toBe(25);
    expect(claimsTableIsEmpty()).toBe(false);
    expect(rowTitles().length).toBe(25);
    expect(rowTitles()[0]).toBe("row 25");
    expect(state.getOffsets[state.getOffsets.length - 1]).toBe(0);
  });

  it("two consecutive deletes both succeed, each carrying a freshly-fetched version token", async () => {
    const state = wireTable([
      { id: "a", title: "alpha" },
      { id: "b", title: "bravo" },
      { id: "c", title: "charlie" },
    ]);

    render(<RowsBrowser table={TABLE as never} canWrite />);
    await waitFor(() => expect(rowTitles()).toEqual(["alpha", "bravo", "charlie"]));

    clickDeleteFor("alpha");
    await waitFor(() => expect(rowTitles()).toEqual(["bravo", "charlie"]));

    clickDeleteFor("bravo");
    await waitFor(() => expect(rowTitles()).toEqual(["charlie"]));

    expect(screen.queryByText(/This row changed since it was loaded/)).toBeNull();
    expect(state.rows.map((r) => r.id)).toEqual(["c"]);
    expect(state.deleteBodies).toHaveLength(2);
    expect(state.deleteBodies[0].version).toBe("v1-a");
    const secondGen = Number(/^v(\d+)-/.exec(state.deleteBodies[1].version)![1]);
    expect(secondGen).toBeGreaterThan(1);
  });
});
