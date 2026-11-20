// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ role: "owner", openTab: vi.fn() }),
}));

import { WebsiteConsole } from "./WebsiteConsole";

const TABLES = [
  { name: "action_items", row_estimate: 11, columns: [{ name: "title", type: "text" }], primary_key: ["title"], writable: true },
  { name: "meetings", row_estimate: 4, columns: [{ name: "title", type: "text" }], primary_key: ["title"], writable: true },
];

function wire() {
  apiFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/website/app-catalog")) {
      return {
        ok: true,
        json: async () => ({ connected: true, supported: true, dialect: "postgres", can_write: true, tables: TABLES }),
      };
    }
    if (url.includes("/api/website/app-rows")) {
      return {
        ok: true,
        json: async () => ({
          connected: true, supported: true, dialect: "postgres", table: "action_items",
          columns: [{ name: "title", type: "text" }],
          rows: [{ title: "Ben will draft a PRD" }],
          row_keys: [{ title: "Ben will draft a PRD" }],
          row_versions: ["v1"], truncated_columns: [[]],
          has_more: false, masked_columns: [], writable: true,
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({ app: { name: "Demo", deployed_url: "https://demo.test", repo_url: null } }),
    };
  });
}

function navButton(name: string) {
  const nav = document.querySelector("nav") as HTMLElement;
  return within(nav).getByRole("button", { name });
}

const isHighlighted = (el: HTMLElement) => el.getAttribute("aria-current") === "page";

beforeEach(() => { apiFetch.mockReset(); wire(); });
afterEach(() => { cleanup(); });

describe("left nav highlights the open table", () => {
  it("keeps Data navigation and table expansion as separate accessible controls", async () => {
    render(<WebsiteConsole />);

    const data = await screen.findByRole("button", { name: /^Data$/ });
    const collapse = await screen.findByRole("button", { name: "Collapse tables" });
    expect(data.contains(collapse)).toBe(false);

    fireEvent.click(data);
    await waitFor(() => expect(data.getAttribute("aria-current")).toBe("page"));
  });

  it("highlights the table opened from the nav, and only that one", async () => {
    render(<WebsiteConsole />);
    fireEvent.click(await screen.findByRole("button", { name: "action_items" }));

    await waitFor(() => expect(isHighlighted(navButton("action_items"))).toBe(true));
    expect(isHighlighted(navButton("meetings"))).toBe(false);
  });

  it("highlights a table opened from its card in the main pane", async () => {
    render(<WebsiteConsole />);
    fireEvent.click(await screen.findByRole("button", { name: /^Data$/ }));

    const cards = await screen.findAllByRole("button", { name: /action_items/ });
    const card = cards.find((c) => !c.closest("nav"));
    fireEvent.click(card!);

    await waitFor(() => expect(isHighlighted(navButton("action_items"))).toBe(true));
  });

  it("clears the highlight when the user goes back to All tables", async () => {
    render(<WebsiteConsole />);
    fireEvent.click(await screen.findByRole("button", { name: "action_items" }));
    await waitFor(() => expect(isHighlighted(navButton("action_items"))).toBe(true));

    fireEvent.click(await screen.findByRole("button", { name: /all tables/i }));

    await waitFor(() => expect(isHighlighted(navButton("action_items"))).toBe(false));
  });

  it("clears the highlight when the user leaves Data for another section", async () => {
    render(<WebsiteConsole />);
    fireEvent.click(await screen.findByRole("button", { name: "action_items" }));
    await waitFor(() => expect(isHighlighted(navButton("action_items"))).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: /^Overview$/ }));

    await waitFor(() => expect(isHighlighted(navButton("action_items"))).toBe(false));
  });
});
