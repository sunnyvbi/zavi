// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ role: "owner", openTab: vi.fn() }),
}));

import { RowsBrowser, entityLabel } from "./WebsiteConsole";

type Column = {
  name: string;
  type: string;
  nullable?: boolean;
  has_default?: boolean;
  generated?: boolean;
  primary_key?: boolean;
  writable?: boolean;
  enum_values?: string[] | null;
};

const TITLE: Column = { name: "title", type: "text", nullable: false, writable: true };

function tableOf(columns: Column[], primaryKey: string[]) {
  return { name: "orders", row_estimate: 1, columns, primary_key: primaryKey, writable: true };
}

function wire(columns: Column[]) {
  apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (!init || !init.method || init.method === "GET") {
      const row: Record<string, unknown> = {};
      for (const c of columns) row[c.name] = c.name === "title" ? "Existing" : "a";
      return {
        ok: true,
        json: async () => ({
          connected: true,
          supported: true,
          dialect: "postgres",
          table: "orders",
          columns,
          rows: [row],
          row_keys: [{ id: "a", slug: "a" }],
          row_versions: ["v1"],
          has_more: false,
          masked_columns: [],
          writable: true,
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  });
}

async function openCreateDrawer(columns: Column[], primaryKey: string[]) {
  wire(columns);
  render(<RowsBrowser table={tableOf(columns, primaryKey) as never} canWrite />);
  const add = await screen.findByRole("button", { name: /add row/i });
  fireEvent.click(add);
  return screen.findByRole("dialog");
}

async function openEditDrawer(columns: Column[], primaryKey: string[]) {
  wire(columns);
  render(<RowsBrowser table={tableOf(columns, primaryKey) as never} canWrite />);
  const edit = await screen.findByRole("button", { name: /edit row/i });
  fireEvent.click(edit);
  return screen.findByRole("dialog");
}

beforeEach(() => { apiFetch.mockReset(); });
afterEach(() => { cleanup(); });

describe("entityLabel", () => {
  it.each([
    ["orders", "Order"],
    ["blog_posts", "Blog Post"],
    ["categories", "Category"],
    ["addresses", "Address"],
    ["interview_qas", "Interview Qa"],
    ["status", "Status"],
    ["media", "Media"],
  ])("%s → %s", (input, expected) => {
    expect(entityLabel(input)).toBe(expected);
  });
});

describe("primary keys in the create drawer", () => {
  it.each([
    ["serial", { name: "id", type: "integer", nullable: false, has_default: true, primary_key: true, writable: true }],
    ["uuid with a default", { name: "id", type: "uuid", nullable: false, has_default: true, primary_key: true, writable: true }],
  ])("does not offer a %s primary key as a field", async (_label, pk) => {
    const drawer = await openCreateDrawer([pk as Column, TITLE], ["id"]);

    expect(drawer.textContent).toContain("Add New Order");
    expect(screen.queryByLabelText("id")).toBeNull();
    expect(screen.getByLabelText("title")).toBeTruthy();
  });

  it("does not offer an identity primary key (writable:false from the backend)", async () => {
    const pk: Column = { name: "id", type: "bigint", nullable: false, primary_key: true, generated: true, writable: false };
    await openCreateDrawer([pk, TITLE], ["id"]);

    expect(screen.queryByLabelText("id")).toBeNull();
  });

  it("DOES offer a natural primary key that has no default", async () => {
    const pk: Column = { name: "slug", type: "text", nullable: false, primary_key: true, writable: true };
    await openCreateDrawer([pk, TITLE], ["slug"]);

    const field = screen.getByLabelText("slug");
    expect(field).toBeTruthy();
    expect(field.closest("label")?.textContent).toContain("*");
  });
});

describe("primary keys in the edit drawer", () => {
  it("offers no primary key at all, natural or otherwise", async () => {
    const pk: Column = { name: "slug", type: "text", nullable: false, primary_key: true, writable: true };
    const drawer = await openEditDrawer([pk, TITLE], ["slug"]);

    expect(drawer.textContent).toContain("Edit Order");
    expect(screen.queryByLabelText("slug")).toBeNull();
    expect(screen.getByLabelText("title")).toBeTruthy();
  });
});

describe("required markers", () => {
  it("marks NOT NULL columns without a default, and leaves the rest unmarked", async () => {
    const columns: Column[] = [
      { name: "slug", type: "text", nullable: false, primary_key: true, writable: true },
      { name: "title", type: "text", nullable: false, writable: true },
      { name: "note", type: "text", nullable: true, writable: true },
      { name: "created_at", type: "timestamp", nullable: false, has_default: true, writable: true },
    ];
    await openCreateDrawer(columns, ["slug"]);

    expect(screen.getByLabelText("title").closest("label")?.textContent).toContain("*");
    expect(screen.getByLabelText("note").closest("label")?.textContent).not.toContain("*");
    expect(screen.getByLabelText("created_at").closest("label")?.textContent).not.toContain("*");
  });
});

describe("enum columns", () => {
  it("renders a select of the real labels instead of a text box", async () => {
    const columns: Column[] = [
      { name: "slug", type: "text", nullable: false, primary_key: true, writable: true },
      { name: "status", type: "order_status", nullable: false, has_default: true, writable: true,
        enum_values: ["pending", "paid", "refunded"] },
    ];
    await openCreateDrawer(columns, ["slug"]);

    const select = screen.getByLabelText("status");
    expect(select.tagName).toBe("SELECT");
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toContain("pending");
    expect(options).toContain("paid");
    expect(options).toContain("refunded");
  });

  it("renders an input when the column has no enum labels", async () => {
    await openCreateDrawer(
      [{ name: "slug", type: "text", nullable: false, primary_key: true, writable: true }, TITLE],
      ["slug"],
    );

    expect(screen.getByLabelText("title").tagName).toBe("INPUT");
  });
});

describe("save path", () => {
  it("sends only the natural primary key and edited fields on create", async () => {
    const columns: Column[] = [
      { name: "id", type: "integer", nullable: false, has_default: true, primary_key: true, writable: true },
      TITLE,
    ];
    await openCreateDrawer(columns, ["id"]);

    fireEvent.change(screen.getByLabelText("title"), { target: { value: "New order" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const post = apiFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.values).toEqual({ title: "New order" });
      expect(body.values).not.toHaveProperty("id");
    });
  });
});
