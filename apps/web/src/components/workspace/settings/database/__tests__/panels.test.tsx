// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
  respond: (_path: string, _method: string): { status: number; body: unknown } => ({ status: 200, body: {} }),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    h.calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const r = h.respond(path, method);
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
  },
}));
vi.mock("../../connectorErrorDialog", () => ({ showConnectorError: vi.fn() }));

import { ChoosePanel, PasteForm } from "../DatabaseSetupPanel";
import { DatabaseSeePanel } from "../DatabaseSeePanel";
import { DatabasePrivacyPanel } from "../DatabasePrivacyPanel";
import { DatabaseCard } from "../DatabaseCard";

const VIEW = {
  dialect: "postgres",
  catalog_hash: "h1",
  discovery: "ready",
  settings_confirmed: false,
  read_only: null,
  tables: [
    { name: "users", rows: 1200, view_of: null, enabled: true, columns: ["id", "email"] },
    { name: "audit", rows: 3, view_of: null, enabled: true, columns: ["id"] },
  ],
  sensitive: [{ table: "users", field: "email", kind: "Email address", hidden: true }],
  removed_by_view: [],
  hidden_fields: [],
};

beforeEach(() => {
  h.calls = [];
  h.respond = () => ({ status: 200, body: {} });
});
afterEach(cleanup);

describe("ChoosePanel", () => {
  it("Quick setup is selected by default; Continue passes the choice", () => {
    const onContinue = vi.fn();
    render(<ChoosePanel onContinue={onContinue} onCancel={() => {}} />);
    expect(screen.getByRole("radio", { name: /Quick setup/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Zavi only reads, never changes anything. Free on every plan.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledWith("cloud");
    fireEvent.click(screen.getByRole("radio", { name: /Keep data on your server/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenLastCalledWith("connector");
  });
});

describe("PasteForm", () => {
  const fill = () => {
    fireEvent.change(screen.getByLabelText("Connection string"), { target: { value: "postgres://u:p@h/db" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & detect schema" }));
  };

  it("MongoDB: no script link, one line instead; DynamoDB: no script link", () => {
    render(<PasteForm onCancel={() => {}} onNext={() => {}} />);
    fireEvent.change(screen.getByLabelText("DB type"), { target: { value: "mongodb" } });
    expect(screen.queryByRole("button", { name: "Don't have a read-only login? We'll write the script." })).toBeNull();
    expect(screen.getByText("MongoDB can't block single fields for a login, so Zavi enforces hidden fields.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("DB type"), { target: { value: "dynamodb" } });
    expect(screen.queryByRole("button", { name: "Don't have a read-only login? We'll write the script." })).toBeNull();
  });

  it("the script link opens a script that follows the chosen database", () => {
    render(<PasteForm onCancel={() => {}} onNext={() => {}} />);
    expect(screen.queryByTestId("read-only-script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Don't have a read-only login? We'll write the script." }));
    expect(screen.getByTestId("read-only-script").textContent).toContain("CREATE ROLE zavi_reader");
    fireEvent.change(screen.getByLabelText("Database"), { target: { value: "mysql" } });
    expect(screen.getByTestId("read-only-script").textContent).toContain("CREATE USER 'zavi_reader'@'%'");
  });

  it("a write-capable login connects with the warning, then Next", async () => {
    h.respond = () => ({ status: 200, body: { ok: true, read_only_check: "can_write", discovery: "pending" } });
    const onNext = vi.fn();
    render(<PasteForm onCancel={() => {}} onNext={onNext} />);
    fill();
    await screen.findByText("Connected. Credentials verified.");
    expect(screen.getByText("This login can write. Zavi only reads, but a read-only login is recommended.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onNext).toHaveBeenCalledWith(expect.objectContaining({ read_only_check: "can_write" }));
  });

  it("a failed probe says nothing was saved", async () => {
    h.respond = () => ({ status: 200, body: { ok: false, discovery_error: "password authentication failed" } });
    render(<PasteForm onCancel={() => {}} onNext={() => {}} />);
    fill();
    await screen.findByText("Couldn't connect to your database");
    expect(screen.getByText(/The username or password was rejected\..*Nothing was saved\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("DatabaseSeePanel", () => {
  it("switches start on; un-hide and switched-off tables are what gets saved", async () => {
    h.respond = (p, m) => (m === "PUT" ? { status: 200, body: { ok: true } } : { status: 200, body: VIEW });
    const onSaved = vi.fn();
    render(<DatabaseSeePanel readOnly="verified" onSaved={onSaved} />);
    await screen.findByText("Zavi checked this login's permissions: it can only read.");
    const hide = screen.getByRole("switch", { name: "Hidden: users.email" });
    expect(hide.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Hidden in Zavi. Your login can still read it.")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Zavi uses users" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(hide);
    fireEvent.click(screen.getByRole("switch", { name: "Zavi uses audit" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const put = h.calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/api/connectors/operator-db/visibility");
    expect(put.body).toEqual({ catalog_hash: "h1", disabled_tables: ["audit"], hidden_fields: [], unhidden_fields: ["users.email"] });
  });

  it("a failed re-scan shows the kept table list with a note; a fresh scan shows no note", async () => {
    h.respond = () => ({ status: 200, body: { ...VIEW, last_rescan_failed_at: "2026-10-14T06:00:00Z", last_good_scan_at: "2026-10-12T09:00:00Z" } });
    render(<DatabaseSeePanel onSaved={() => {}} />);
    await screen.findByText("Zavi’s latest check of your tables did not finish");
    expect(screen.getByText(/keeps the table list from Oct 12, 2026 below/)).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Zavi uses users" })).toBeTruthy();
    cleanup();
    h.respond = () => ({ status: 200, body: VIEW });
    render(<DatabaseSeePanel onSaved={() => {}} />);
    await screen.findByRole("switch", { name: "Zavi uses users" });
    expect(screen.queryByText("Zavi’s latest check of your tables did not finish")).toBeNull();
  });

  it("Make it stronger reveals the database-side script", async () => {
    h.respond = () => ({ status: 200, body: VIEW });
    render(<DatabaseSeePanel onSaved={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Make it stronger: remove these in your database" }));
    expect(screen.getByText("Then your login cannot read them at all, whatever Zavi does.")).toBeTruthy();
    expect(screen.getByText(/GRANT SELECT \("id"\) ON "users" TO zavi_reader;/)).toBeTruthy();
  });

  it("MongoDB: no script anywhere, one line instead; the read-only result is not claimed", async () => {
    h.respond = () => ({ status: 200, body: { ...VIEW, dialect: "mongodb", read_only: "unknown" } });
    render(<DatabaseSeePanel check onSaved={() => {}} />);
    await screen.findByText("Sensitive-looking fields");
    expect(screen.getByText("Collections Zavi may use")).toBeTruthy();
    expect(screen.getByText("Couldn't check automatically.")).toBeTruthy();
    expect(screen.getByText("MongoDB can't block single fields for a login, so Zavi enforces hidden fields.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make it stronger: remove these in your database" })).toBeNull();
    expect(screen.queryByText(/db\.createUser|createView|CREATE ROLE/)).toBeNull();
    expect(h.calls[0].path).toBe("/api/connectors/operator-db/visibility?check=1");
  });

  it("a save the server refuses because the database changed reloads the view", async () => {
    h.respond = (_p, m) =>
      m === "PUT" ? { status: 409, body: { error: { message: "Your database changed, review again." } } } : { status: 200, body: VIEW };
    const onSaved = vi.fn();
    render(<DatabaseSeePanel onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => expect(h.calls.filter((c) => c.method === "GET").length).toBe(2));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("an unencrypted connection is warned about with how to fix it", async () => {
    h.respond = () => ({ status: 200, body: { ...VIEW, dialect: "mysql", transport: "plaintext" } });
    render(<DatabaseSeePanel onSaved={() => {}} />);
    await screen.findByText("Unencrypted connection");
    expect(screen.getByText(/paste the login without ssl=false/)).toBeTruthy();
  });

  it("an encrypted connection has no warning", async () => {
    h.respond = () => ({ status: 200, body: { ...VIEW, transport: "unverified_tls" } });
    render(<DatabaseSeePanel onSaved={() => {}} />);
    await screen.findByText("Sensitive-looking columns");
    expect(screen.queryByText("Unencrypted connection")).toBeNull();
  });

  it("while discovery is pending it says so", async () => {
    h.respond = () => ({ status: 200, body: { ...VIEW, discovery: "pending", tables: [], sensitive: [] } });
    render(<DatabaseSeePanel onSaved={() => {}} />);
    await screen.findByText("Zavi is reading your tables. This takes about a minute.");
  });
});

describe("DatabasePrivacyPanel", () => {
  it("an old connection shows its real behaviour; the recommendation is clearly not saved", async () => {
    h.respond = () => ({ status: 200, body: { raw_results_retention: null, chat_retention: null, providers: [] } });
    render(<DatabasePrivacyPanel onSaved={() => {}} onCancel={() => {}} />);
    expect((await screen.findByTestId("privacy-legacy")).textContent).toBe(
      "Raw results are kept until you choose. The options below are recommended, not saved yet.",
    );
    expect(screen.queryByText("Sensible defaults are set. You can change them later from Manage.")).toBeNull();
  });

  it("a saved connection shows the normal line", async () => {
    h.respond = () => ({ status: 200, body: { raw_results_retention: "7", chat_retention: "forever", providers: [] } });
    render(<DatabasePrivacyPanel onSaved={() => {}} onCancel={() => {}} />);
    await screen.findByText("Sensible defaults are set. You can change them later from Manage.");
    expect((screen.getByLabelText("7 days") as HTMLInputElement).checked).toBe(true);
  });

  it("defaults are selected for a new connection; Save PUTs; provider line comes from the API", async () => {
    h.respond = (_p, m) =>
      m === "PUT"
        ? { status: 200, body: { ok: true } }
        : { status: 200, body: { raw_results_retention: null, chat_retention: null, providers: [{ name: "Anthropic", line: "Never used for training · Kept up to 30 days for safety checks" }] } };
    const onSaved = vi.fn();
    render(<DatabasePrivacyPanel onSaved={onSaved} onCancel={() => {}} />);
    await screen.findByText("Never used for training · Kept up to 30 days for safety checks");
    expect((screen.getByLabelText("Delete after each run") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Forever") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getAllByLabelText("30 days")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save and finish" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(h.calls.find((c) => c.method === "PUT")!.body).toEqual({ raw_results_retention: "30", chat_retention: "forever" });
  });
});

describe("DatabaseCard", () => {
  it("member, not connected: asks an owner or admin and requests access once", async () => {
    h.respond = (p) =>
      p.endsWith("/setup") ? { status: 200, body: { connected: false } } : { status: 200, body: { ok: true, sent: true, already_requested: false } };
    render(<DatabaseCard connected={false} canManage={false} />);
    expect(await screen.findByText("Ask an owner or admin to connect your database")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Request access" }));
    await screen.findByRole("button", { name: "Request sent" });
    expect(h.calls.filter((c) => c.path === "/api/workspace/database/request-access")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
  });

  it("member, connected: no menu", async () => {
    h.respond = () => ({ status: 200, body: { connected: true, mode: "direct", dialect: "postgres", legacy: false, managed_by: null, discovery: "ready", settings_confirmed: true } });
    render(<DatabaseCard connected canManage={false} />);
    await waitFor(() => expect(h.calls.length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
  });

  it("owner, old connection: no banner, Manage still opens What Zavi can see", async () => {
    h.respond = () => ({ status: 200, body: { connected: true, mode: "direct", dialect: "postgres", legacy: true, managed_by: null, discovery: "ready", settings_confirmed: false } });
    render(<DatabaseCard connected canManage />);
    await screen.findByRole("button", { name: "Manage" });
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("owner, unencrypted direct connection: the warning, and Reconnect opens the mode choice", async () => {
    h.respond = () => ({ status: 200, body: { connected: true, mode: "direct", dialect: "mongodb", legacy: false, managed_by: null, discovery: "ready", settings_confirmed: true, transport: "plaintext" } });
    render(<DatabaseCard connected canManage />);
    await screen.findByText("Unencrypted connection");
    expect(screen.getByText(/without tls=false/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(screen.getByText("Connect your database")).toBeTruthy();
    expect(screen.queryByText("Unencrypted connection")).toBeNull();
  });

  it("member: no unencrypted warning (only an owner or admin can fix it)", async () => {
    h.respond = () => ({ status: 200, body: { connected: true, mode: "direct", dialect: "mysql", legacy: false, managed_by: null, discovery: "ready", settings_confirmed: true, transport: "plaintext" } });
    render(<DatabaseCard connected canManage={false} />);
    await waitFor(() => expect(h.calls.length).toBeGreaterThan(0));
    expect(screen.queryByText("Unencrypted connection")).toBeNull();
  });

  it("owner, not connected: Connect opens the mode choice", async () => {
    h.respond = () => ({ status: 200, body: { connected: false } });
    render(<DatabaseCard connected={false} canManage />);
    fireEvent.click(await screen.findByRole("button", { name: /Connect/ }));
    expect(screen.getByText("Connect your database")).toBeTruthy();
  });
});
