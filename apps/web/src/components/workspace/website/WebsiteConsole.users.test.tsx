// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

let mockRole: "owner" | "admin" | "member" | null = "owner";
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ role: mockRole, openTab: vi.fn() }),
}));

import { UsersView, __resetAppCatalogInflight } from "./WebsiteConsole";

type Col = {
  name: string;
  type: string;
  nullable?: boolean;
  writable?: boolean;
  primary_key?: boolean;
  generated?: boolean;
  enum_values?: string[] | null;
};

const CATALOG_COLS: Col[] = [
  { name: "id", type: "uuid", nullable: false },
  { name: "full_name", type: "text", nullable: false },
  { name: "role", type: "text", nullable: true },
  { name: "email", type: "text", nullable: false },
  { name: "password_hash", type: "text", nullable: false },
  { name: "city", type: "text", nullable: true },
];

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function wire({
  columns = CATALOG_COLS,
  rows = [
    {
      id: "u1",
      full_name: "upcardesign",
      role: "admin",
      email: "upcardesign@gmail.com",
      password_hash: "••••••",
      city: "Hyderabad",
    },
  ],
  hasMore = false,
  masked = ["password_hash"],
  writable = true,
  mutation = { status: 200, body: { ok: true } },
}: {
  columns?: Col[];
  rows?: Record<string, unknown>[];
  hasMore?: boolean;
  masked?: string[];
  writable?: boolean;
  mutation?: { status?: number; body?: unknown };
} = {}) {
  apiFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method && init.method !== "GET") {
      return Promise.resolve(jsonRes(mutation.body ?? { ok: true }, mutation.status ?? 200));
    }
    if (url.includes("/app-catalog")) {
      return Promise.resolve(
        jsonRes({
          connected: true,
          dialect: "postgres",
          tables: [{ name: "users", row_estimate: null, columns }],
        }),
      );
    }
    if (url.includes("/app-rows")) {
      return Promise.resolve(
        jsonRes({
          connected: true,
          supported: true,
          dialect: "postgres",
          table: "users",
          columns,
          rows,
          row_keys: rows.map((row) => ({ id: row.id as string })),
          row_versions: rows.map((_, index) => String(index + 1)),
          has_more: hasMore,
          masked_columns: masked,
          writable,
        }),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const rowsCalls = () =>
  apiFetch.mock.calls.filter((c) => String(c[0]).includes("/app-rows"));

beforeEach(() => {
  apiFetch.mockReset();
  mockRole = "owner";
  __resetAppCatalogInflight();
});
afterEach(cleanup);

describe("UsersView", () => {
  it("renders the app's real users for an owner", async () => {
    wire();
    render(<UsersView deployedUrl="https://app.example.com" />);
    expect(await screen.findByText("upcardesign@gmail.com")).toBeTruthy();
    expect(screen.getByText("upcardesign")).toBeTruthy();
    expect(screen.getByText("Hyderabad")).toBeTruthy();
  });

  it("shows an exact count when the table fit in one page", async () => {
    wire();
    render(<UsersView deployedUrl={null} />);
    expect(await screen.findByText("Users (1)")).toBeTruthy();
  });

  it("says 100+ rather than guessing when there are more users than one page", async () => {
    wire({ hasMore: true });
    render(<UsersView deployedUrl={null} />);
    expect(await screen.findByText("Users (100+)")).toBeTruthy();
  });

  it("DENIES a plain member — locked state, and no rows request is fired", async () => {
    mockRole = "member";
    wire();
    render(<UsersView deployedUrl={null} />);
    expect(
      await screen.findByText(/visible to owners and admins/i),
    ).toBeTruthy();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(rowsCalls()).toHaveLength(0);
    expect(screen.queryByText("upcardesign@gmail.com")).toBeNull();
  });

  it("treats a null role like a member (least-privilege fallback)", async () => {
    mockRole = null;
    wire();
    render(<UsersView deployedUrl={null} />);
    expect(await screen.findByText(/visible to owners and admins/i)).toBeTruthy();
    expect(rowsCalls()).toHaveLength(0);
  });

  it("drops secret-named columns from the table entirely", async () => {
    wire();
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("upcardesign@gmail.com");
    expect(screen.queryByText("password_hash")).toBeNull();
    expect(screen.queryByText("••••••")).toBeNull();
  });

  it("hides the Role column and the roles filter when the app has no role column", async () => {
    const noRole = CATALOG_COLS.filter((c) => c.name !== "role");
    wire({
      columns: noRole,
      rows: [
        {
          id: "u1",
          full_name: "upcardesign",
          email: "upcardesign@gmail.com",
          password_hash: "••••••",
          city: "Hyderabad",
        },
      ],
    });
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("upcardesign@gmail.com");
    expect(screen.queryByRole("combobox", { name: /filter by role/i })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Role" })).toBeNull();
  });

  it("offers a roles filter built from the values actually present", async () => {
    wire({
      rows: [
        { id: "1", full_name: "A", role: "admin", email: "a@x.com", password_hash: "•", city: "" },
        { id: "2", full_name: "B", role: "user", email: "b@x.com", password_hash: "•", city: "" },
      ],
    });
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("a@x.com");
    const select = screen.getByRole("combobox", { name: /filter by role/i });
    const values = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(values).toEqual(["all roles", "admin", "user"]);
  });

  it("says the app has no users table when nothing qualifies", async () => {
    apiFetch.mockImplementation((url: string) => {
      if (url.includes("/app-catalog")) {
        return Promise.resolve(
          jsonRes({
            connected: true,
            tables: [
              { name: "posts", row_estimate: null, columns: [{ name: "title", type: "text" }] },
            ],
          }),
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    render(<UsersView deployedUrl={null} />);
    expect(await screen.findByText("This site doesn’t have user accounts.")).toBeTruthy();
    expect(rowsCalls()).toHaveLength(0);
  });

  it("collapses concurrent mounts into ONE catalog request", async () => {
    wire();
    render(
      <>
        <UsersView deployedUrl={null} />
        <UsersView deployedUrl={null} />
      </>,
    );
    await screen.findAllByText("upcardesign@gmail.com");
    const catalogCalls = apiFetch.mock.calls.filter((c) =>
      String(c[0]).includes("/app-catalog"),
    );
    expect(catalogCalls).toHaveLength(1);
  });

  it("does not claim there are zero pending requests", async () => {
    wire();
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("upcardesign@gmail.com");
    expect(screen.queryByText("No pending requests.")).toBeNull();
  });
});

const WRITABLE_COLS: Col[] = [
  { name: "id", type: "uuid", nullable: false, primary_key: true, writable: false },
  { name: "full_name", type: "text", nullable: false, writable: true },
  { name: "role", type: "text", nullable: true, writable: true },
  { name: "email", type: "text", nullable: false, writable: true },
];

const ENUM_ROLE_COLS: Col[] = [
  { name: "id", type: "uuid", nullable: false, primary_key: true, writable: false },
  { name: "full_name", type: "text", nullable: false, writable: true },
  {
    name: "role",
    type: "user_role",
    nullable: true,
    writable: true,
    enum_values: ["admin", "editor", "viewer"],
  },
  { name: "email", type: "text", nullable: false, writable: true },
];

const THREE_USERS = [
  { id: "u1", full_name: "Alice", role: "admin", email: "alice@example.com" },
  { id: "u2", full_name: "Bob", role: "user", email: "bob@example.com" },
  { id: "u3", full_name: "Carol", role: "admin", email: "carol@example.com" },
];

const mutationCalls = (method: "PATCH" | "DELETE") =>
  apiFetch.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === method);

const bodyOf = (call: unknown[]) =>
  JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;

const confirmDialog = () => screen.queryByRole("alertdialog");
const clickConfirm = (label: RegExp) =>
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: label }));
const clickCancel = () =>
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /^Cancel$/ }));

describe("UsersView — role editing and removal", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockImplementation(() => {
      throw new Error("window.confirm must not be used — expected the in-app ConfirmDialog");
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a role dropdown only when the rows route says the column is writable", async () => {
    wire({ columns: WRITABLE_COLS, rows: THREE_USERS });
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("alice@example.com");
    expect(screen.getAllByLabelText(/^Role for /)).toHaveLength(3);
  });

  it("renders the role read-only when the table itself is not writable", async () => {
    wire({ columns: WRITABLE_COLS, rows: THREE_USERS, writable: false });
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("alice@example.com");
    expect(screen.queryByLabelText(/^Role for /)).toBeNull();
    expect(screen.queryByLabelText(/^Remove /)).toBeNull();
  });

  it("renders the role read-only when the column metadata is absent (fail-closed)", async () => {
    wire({ rows: THREE_USERS });
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("alice@example.com");
    expect(screen.queryByLabelText(/^Role for /)).toBeNull();
  });

  it("renders the role read-only when every user already holds the only observed role", async () => {
    wire({
      columns: WRITABLE_COLS,
      rows: [{ id: "u1", full_name: "Alice", role: "admin", email: "alice@example.com" }],
    });
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("alice@example.com");
    expect(screen.queryByLabelText(/^Role for /)).toBeNull();
  });

  it("allows editing an ENUM-backed role column", async () => {
    wire({ columns: ENUM_ROLE_COLS, rows: THREE_USERS });
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("alice@example.com");
    expect(screen.getAllByLabelText(/^Role for /)).toHaveLength(3);
  });

  it("offers every declared enum label, including ones no row holds yet", async () => {
    wire({ columns: ENUM_ROLE_COLS, rows: THREE_USERS });
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("alice@example.com");
    const select = screen.getAllByLabelText(/^Role for /)[0] as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "admin",
      "editor",
      "viewer",
    ]);
  });

  it("keeps a non-textual, non-enum role column read-only", async () => {
    wire({
      columns: [
        { name: "id", type: "uuid", nullable: false, primary_key: true, writable: false },
        { name: "role", type: "integer", nullable: true, writable: true },
        { name: "email", type: "text", nullable: false, writable: true },
      ],
      rows: [
        { id: "u1", role: 1, email: "alice@example.com" },
        { id: "u2", role: 2, email: "bob@example.com" },
      ],
    });
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("alice@example.com");
    expect(screen.queryByLabelText(/^Role for /)).toBeNull();
  });

  it("edits the row the operator can actually see, not the filtered index", async () => {
    wire({ columns: WRITABLE_COLS, rows: THREE_USERS });
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("alice@example.com");

    fireEvent.change(screen.getByLabelText("Search users"), { target: { value: "Carol" } });
    const selects = screen.getAllByLabelText(/^Role for /);
    expect(selects).toHaveLength(1);
    fireEvent.change(selects[0], { target: { value: "user" } });

    await waitFor(() => expect(mutationCalls("PATCH")).toHaveLength(1));
    const body = bodyOf(mutationCalls("PATCH")[0]);
    expect(body.key).toEqual({ id: "u3" });
    expect(body.version).toBe("3");
    expect(body.values).toEqual({ role: "user" });
  });

  it("deletes the row the operator can actually see, not the filtered index", async () => {
    wire({ columns: WRITABLE_COLS, rows: THREE_USERS });
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("alice@example.com");

    fireEvent.change(screen.getByLabelText("Filter by role"), { target: { value: "admin" } });
    const removes = screen.getAllByLabelText(/^Remove /);
    expect(removes).toHaveLength(2);
    fireEvent.click(removes[1]);
    clickConfirm(/^Remove user$/);

    await waitFor(() => expect(mutationCalls("DELETE")).toHaveLength(1));
    const body = bodyOf(mutationCalls("DELETE")[0]);
    expect(body.key).toEqual({ id: "u3" });
    expect(body.version).toBe("3");
  });

  it("uses an in-app dialog — not a native browser confirm — to remove a user", async () => {
    wire({ columns: WRITABLE_COLS, rows: THREE_USERS });
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("alice@example.com");

    fireEvent.click(screen.getAllByLabelText(/^Remove /)[0]);
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/Alice/)).toBeTruthy();
    expect(within(dialog).getByText(/permanent/i)).toBeTruthy();
  });

  it("fires nothing when the delete dialog is cancelled, and refetches when accepted", async () => {
    wire({ columns: WRITABLE_COLS, rows: THREE_USERS });
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("alice@example.com");
    const before = rowsCalls().length;

    fireEvent.click(screen.getAllByLabelText(/^Remove /)[0]);
    clickCancel();
    expect(confirmDialog()).toBeNull();
    expect(mutationCalls("DELETE")).toHaveLength(0);

    fireEvent.click(screen.getAllByLabelText(/^Remove /)[0]);
    clickConfirm(/^Remove user$/);
    await waitFor(() => expect(mutationCalls("DELETE")).toHaveLength(1));
    await waitFor(() => expect(rowsCalls().length).toBeGreaterThan(before));
  });

  it("confirms before granting a privileged role, but not for an ordinary one", async () => {
    wire({ columns: WRITABLE_COLS, rows: THREE_USERS });
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("bob@example.com");

    fireEvent.change(screen.getByLabelText("Role for Bob"), { target: { value: "admin" } });
    expect(confirmDialog()).toBeTruthy();
    clickCancel();
    expect(mutationCalls("PATCH")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Role for Alice"), { target: { value: "user" } });
    expect(confirmDialog()).toBeNull();
    await waitFor(() => expect(mutationCalls("PATCH")).toHaveLength(1));
  });

  it("reloads and explains itself when the row changed underneath (409)", async () => {
    wire({
      columns: WRITABLE_COLS,
      rows: THREE_USERS,
      mutation: {
        status: 409,
        body: {
          error: {
            code: "app_db_stale_row",
            message: "This row changed since it was loaded. Refresh and try again.",
          },
        },
      },
    });
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("alice@example.com");
    const before = rowsCalls().length;

    fireEvent.change(screen.getByLabelText("Role for Alice"), { target: { value: "user" } });
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(screen.getByRole("status").textContent).toMatch(/changed since it was loaded/i);
    await waitFor(() => expect(rowsCalls().length).toBeGreaterThan(before));
  });

  it("surfaces the rate limiter's own message on a 429", async () => {
    wire({
      columns: WRITABLE_COLS,
      rows: THREE_USERS,
      mutation: {
        status: 429,
        body: { error: { code: "rate_limited", message: "Too many data changes; slow down." } },
      },
    });
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("alice@example.com");

    fireEvent.change(screen.getByLabelText("Role for Alice"), { target: { value: "user" } });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/Too many data changes/i),
    );
  });

  it("says where a row went when an edit pushes it out of the active filter", async () => {
    wire({ columns: WRITABLE_COLS, rows: THREE_USERS });
    render(<UsersView deployedUrl={null} />);
    await screen.findByText("alice@example.com");

    fireEvent.change(screen.getByLabelText("Filter by role"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Role for Alice"), { target: { value: "user" } });

    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/no longer matches/i));
  });
});
