// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

let mockRole: "owner" | "admin" | "member" | null = "owner";
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ role: mockRole, openTab: vi.fn() }),
}));

vi.mock("../Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

import { DataView, __resetAppCatalogInflight } from "./WebsiteConsole";

const CATALOG = {
  connected: true,
  can_write: true,
  dialect: "postgres",
  tables: [
    {
      name: "listings",
      row_estimate: 3,
      columns: [
        { name: "id", type: "uuid", nullable: false, primary_key: true },
        { name: "title", type: "text", nullable: false },
      ],
      primary_key: ["id"],
      writable: true,
    },
  ],
  entities: {},
};

function rowsCalls() {
  return apiFetch.mock.calls.filter((c) => String(c[0]).includes("/app-rows"));
}

beforeEach(() => {
  apiFetch.mockReset();
  __resetAppCatalogInflight();
  apiFetch.mockImplementation(async (url: string) => {
    if (String(url).includes("/app-catalog")) {
      return { ok: true, json: async () => CATALOG };
    }
    return {
      ok: true,
      json: async () => ({
        connected: true,
        supported: true,
        dialect: "postgres",
        table: "listings",
        columns: CATALOG.tables[0].columns,
        rows: [{ id: "r1", title: "row one" }],
        row_keys: [{ id: "r1" }],
        row_versions: ["v1"],
        has_more: false,
        masked_columns: [],
        writable: true,
      }),
    };
  });
});

afterEach(() => {
  cleanup();
  mockRole = "owner";
});

describe("DataView role gate", () => {
  it("DENIES a plain member — locked state, and no rows request is fired", async () => {
    mockRole = "member";
    render(<DataView />);

    expect(await screen.findByText(/visible to owners and admins/i)).toBeTruthy();
    expect(screen.queryByText(/try again in a moment/i)).toBeNull();
    expect(rowsCalls()).toHaveLength(0);
  });

  it("treats a null role like a member (least-privilege fallback)", async () => {
    mockRole = null;
    render(<DataView />);

    expect(await screen.findByText(/visible to owners and admins/i)).toBeTruthy();
    expect(rowsCalls()).toHaveLength(0);
  });

  it("ALLOWS an owner — renders the table list, no locked state", async () => {
    mockRole = "owner";
    render(<DataView />);

    await waitFor(() => expect(screen.getByText("listings")).toBeTruthy());
    expect(screen.queryByText(/visible to owners and admins/i)).toBeNull();
  });

  it("ALLOWS an admin", async () => {
    mockRole = "admin";
    render(<DataView />);

    await waitFor(() => expect(screen.getByText("listings")).toBeTruthy());
    expect(screen.queryByText(/visible to owners and admins/i)).toBeNull();
  });
});
