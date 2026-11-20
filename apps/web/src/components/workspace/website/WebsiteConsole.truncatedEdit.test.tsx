// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ role: "owner", openTab: vi.fn() }),
}));

import { RowsBrowser } from "./WebsiteConsole";

const COLUMNS = [
  { name: "slug", type: "text", nullable: false, primary_key: true, writable: true },
  { name: "title", type: "text", nullable: false, writable: true },
  { name: "body", type: "text", nullable: true, writable: true },
];

const TABLE = { name: "blog_posts", row_estimate: 1, columns: COLUMNS, primary_key: ["slug"], writable: true };

const STUMP = `${"x".repeat(499)}…`;

function wire() {
  apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (!init || !init.method || init.method === "GET") {
      return {
        ok: true,
        json: async () => ({
          connected: true,
          supported: true,
          dialect: "postgres",
          table: "blog_posts",
          columns: COLUMNS,
          rows: [{ slug: "hello-world", title: "Hello", body: STUMP }],
          row_keys: [{ slug: "hello-world" }],
          row_versions: ["v1"],
          truncated_columns: [["body"]],
          has_more: false,
          masked_columns: [],
          writable: true,
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  });
}

async function openEditor() {
  wire();
  render(<RowsBrowser table={TABLE as never} canWrite />);
  fireEvent.click(await screen.findByRole("button", { name: /edit row/i }));
  return screen.findByRole("dialog");
}

const patchCalls = () =>
  apiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");

beforeEach(() => { apiFetch.mockReset(); });
afterEach(() => { cleanup(); });

describe("truncated long-text columns", () => {
  it("does not let the user edit a truncated value", async () => {
    await openEditor();
    const body = screen.getByLabelText("body") as HTMLInputElement | HTMLTextAreaElement;

    expect(body.hasAttribute("readonly") || body.hasAttribute("disabled")).toBe(true);
  });

  it("tells the user why the field cannot be edited here", async () => {
    const drawer = await openEditor();
    expect(drawer.textContent).toMatch(/too long to edit|shortened for display|not shown in full/i);
  });

  it("never sends a truncated value, even when another field is edited", async () => {
    await openEditor();

    fireEvent.change(screen.getByLabelText("title"), { target: { value: "Hello again" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(patchCalls().length).toBe(1));
    const body = JSON.parse((patchCalls()[0][1] as RequestInit).body as string);

    expect(body.values).toEqual({ title: "Hello again" });
    expect(body.values).not.toHaveProperty("body");
    expect(JSON.stringify(body)).not.toContain("…");
  });

  it("still refuses to send the value even if the field is forced to change", async () => {
    await openEditor();
    fireEvent.change(screen.getByLabelText("body"), { target: { value: "tampered" } });
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "Hello again" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(patchCalls().length).toBe(1));
    const body = JSON.parse((patchCalls()[0][1] as RequestInit).body as string);
    expect(body.values).toEqual({ title: "Hello again" });
  });

  it("re-points the editor when the row at that index changes underneath it", async () => {
    const rows = [
      { slug: "first", title: "First", body: "b1" },
      { slug: "second", title: "Second", body: "b2" },
    ];
    let served = [...rows];
    apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || !init.method || init.method === "GET") {
        return {
          ok: true,
          json: async () => ({
            connected: true, supported: true, dialect: "postgres", table: "blog_posts",
            columns: COLUMNS,
            rows: served,
            row_keys: served.map((r) => ({ slug: r.slug })),
            row_versions: served.map(() => "v1"),
            truncated_columns: served.map(() => []),
            has_more: false, masked_columns: [], writable: true,
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<RowsBrowser table={TABLE as never} canWrite />);
    fireEvent.click((await screen.findAllByRole("button", { name: /edit row/i }))[0]);
    await screen.findByRole("dialog");
    expect((screen.getByLabelText("title") as HTMLInputElement).value).toBe("First");

    served = [rows[1]];
    fireEvent.click(screen.getAllByRole("button", { name: /delete row/i })[0]);

    await waitFor(() => {
      const title = screen.queryByLabelText("title") as HTMLInputElement | null;
      expect(title === null || title.value === "Second").toBe(true);
    });
    confirmSpy.mockRestore();
  });

  it("still allows normal editing of columns that were not truncated", async () => {
    await openEditor();

    fireEvent.change(screen.getByLabelText("title"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(patchCalls().length).toBe(1));
    const body = JSON.parse((patchCalls()[0][1] as RequestInit).body as string);
    expect(body.values.title).toBe("Renamed");
  });
});
