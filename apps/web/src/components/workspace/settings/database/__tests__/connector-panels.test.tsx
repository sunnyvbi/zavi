// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string }>,
  respond: (_path: string, _method: string): { status: number; body: unknown } => ({ status: 200, body: {} }),
  confirm: true,
}));
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    h.calls.push({ path, method });
    const r = h.respond(path, method);
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
  },
}));
vi.mock("../../connectorErrorDialog", () => ({ showConnectorError: vi.fn() }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn(async () => h.confirm) }));

import { ConnectorInstallPanel, installState } from "../ConnectorInstallPanel";
import { ConnectorRulesPanel } from "../ConnectorRulesPanel";
import { ConnectorStatusPanel } from "../ConnectorStatusPanel";
import { connectorTileStatus, dbTileDescription, whatCanLeaveText } from "../databaseTile";

const CODE = "zpair_" + "A".repeat(26);
const command = `docker run -d --name zavi-connector --restart always \\\n  -e ZAVI_PAIR=${CODE} \\\n  -p 127.0.0.1:7801:7801 \\\n  -v zavi-connector:/data \\\n  ghcr.io/rravi149/zavi-connector:1.0.1`;
const rules = { allowed_tables: ["bookings", "listings"], blocked_fields: ["users.email", "users.phone"], what_can_leave: "totals_and_counts_only", max_rows: 200 };
const online = (over: Record<string, unknown> = {}) => ({
  paired: true,
  online: true,
  machine: "db-box-1",
  version: "1.0.3",
  dialect: "postgres",
  last_seen_at: new Date().toISOString(),
  last_seen_age: "5s",
  paired_at: new Date(Date.now() + 1000).toISOString(),
  pairing_id: "code-1",
  rules,
  skipped: null,
  ...over,
});

beforeEach(() => {
  h.calls = [];
  h.confirm = true;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("install panel", () => {
  it("mints a one-time code, shows the decided command and lines, and waits", async () => {
    h.respond = (path, method) =>
      method === "POST" ? { status: 200, body: { code: CODE, pairing_id: "code-1", issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 1_800_000).toISOString(), expires_in_seconds: 1800, command } } : { status: 200, body: { paired: false } };
    render(<ConnectorInstallPanel onCancel={() => {}} onOnline={() => {}} />);
    expect(await screen.findByText(/ZAVI_PAIR=zpair_A{26}/)).toBeTruthy();
    expect(screen.getByText(/Needs to reach api.zaviagent.com on port 443. The pairing code works once and expires in 30 minutes./)).toBeTruthy();
    expect(screen.getByText(/Docker secret named zavi_connector_key/)).toBeTruthy();
    expect(await screen.findByText("Waiting for your connector to check in. This updates by itself.")).toBeTruthy();
    expect(h.calls[0]).toEqual({ path: "/api/connectors/operator-db/connector/pair-code", method: "POST" });
  });
  it("turns online when THIS code's connector checks in, and tells the card", async () => {
    h.respond = (_p, method) =>
      method === "POST" ? { status: 200, body: { code: CODE, pairing_id: "code-1", issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 1_800_000).toISOString(), expires_in_seconds: 1800, command } } : { status: 200, body: online() };
    const onOnline = vi.fn();
    render(<ConnectorInstallPanel onCancel={() => {}} onOnline={onOnline} />);
    expect(await screen.findByText(/Connector online on db-box-1 · version 1.0.3 · last seen 5s ago/)).toBeTruthy();
    expect(screen.getByText(/to add your database. The password goes there, not/)).toBeTruthy();
    await waitFor(() => expect(onOnline).toHaveBeenCalledTimes(1));
    expect(document.body.textContent).not.toContain(CODE);
  });
  it("an older connector (different pairing id) never counts as online for a new code", async () => {
    h.respond = (_p, method) =>
      method === "POST"
        ? { status: 200, body: { code: CODE, pairing_id: "code-2", issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 1_800_000).toISOString(), expires_in_seconds: 1800, command } }
        : { status: 200, body: online({ pairing_id: "code-1" }) };
    render(<ConnectorInstallPanel onCancel={() => {}} onOnline={() => {}} />);
    expect(await screen.findByText("Waiting for your connector to check in. This updates by itself.")).toBeTruthy();
  });
  it("a code that could not be minted offers a retry", async () => {
    h.respond = () => ({ status: 500, body: { error: { message: "x" } } });
    render(<ConnectorInstallPanel onCancel={() => {}} onOnline={() => {}} />);
    expect(await screen.findByText("Couldn’t make a pairing code.")).toBeTruthy();
  });
  it("installState: server pairing id decides online; expiry is elapsed monotonic time, never the browser clock", () => {
    const other = online({ pairing_id: "code-1" }) as never;
    const mine = online({ pairing_id: "code-2" }) as never;
    expect(installState("code-2", 1800, 100, other, 100 + 1_799_000, false)).toBe("waiting");
    expect(installState("code-2", 1800, 100, other, 100 + 1_800_000, false)).toBe("expired");
    expect(installState("code-2", 1800, 100, mine, 100 + 5_000, false)).toBe("online");
    expect(installState(null, null, null, null, 0, true)).toBe("mint_failed");
    expect(installState(null, null, null, null, 0, false)).toBe("minting");
  });
  it("expired code -> banner and a new code on request", async () => {
    let mints = 0;
    h.respond = (_p, method) => {
      if (method === "POST") {
        mints += 1;
        return { status: 200, body: { code: CODE, pairing_id: "code-9", issued_at: new Date().toISOString(), expires_at: new Date().toISOString(), expires_in_seconds: 0, command } };
      }
      return { status: 200, body: { paired: false } };
    };
    render(<ConnectorInstallPanel onCancel={() => {}} onOnline={() => {}} />);
    expect(await screen.findByText("The pairing code expired before a connector used it.")).toBeTruthy();
    fireEvent.click(screen.getByText("Get a new pairing code"));
    await waitFor(() => expect(mints).toBe(2));
  });
});

describe("rules (read-only)", () => {
  it("shows the connector's rules with no way to change them", async () => {
    h.respond = () => ({ status: 200, body: online() });
    const { container } = render(<ConnectorRulesPanel onDone={() => {}} onRemoved={() => {}} />);
    expect(await screen.findByText("bookings, listings")).toBeTruthy();
    expect(screen.getByText("users.email, users.phone")).toBeTruthy();
    expect(screen.getByText("Totals and counts only, max 200 rows")).toBeTruthy();
    expect(screen.getByText("Zavi cannot change these. To change them, open localhost:7801/rules on db-box-1.")).toBeTruthy();
    expect(screen.getByText("Only owners and admins can remove the connector.")).toBeTruthy();
    expect(container.querySelectorAll("input, select, textarea")).toHaveLength(0);
  });
  it("rules not reported yet -> says so, never guesses", async () => {
    h.respond = () => ({ status: 200, body: online({ rules: null }) });
    render(<ConnectorRulesPanel onDone={() => {}} onRemoved={() => {}} />);
    expect(await screen.findByText(/has not reported rules yet/)).toBeTruthy();
  });
  it("Remove connector -> confirm -> removed with the local command", async () => {
    h.respond = (path) =>
      path.endsWith("/remove") ? { status: 200, body: { ok: true, removed: true, machine: "db-box-1", removal_command: "docker rm -f zavi-connector && docker volume rm zavi-connector" } } : { status: 200, body: online() };
    const onRemoved = vi.fn();
    render(<ConnectorRulesPanel onDone={() => {}} onRemoved={onRemoved} />);
    await screen.findByText("bookings, listings");
    await act(async () => {
      fireEvent.click(screen.getByText("Remove connector"));
    });
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith("docker rm -f zavi-connector && docker volume rm zavi-connector"));
  });
  it("cancelled confirm removes nothing", async () => {
    h.confirm = false;
    h.respond = () => ({ status: 200, body: online() });
    render(<ConnectorRulesPanel onDone={() => {}} onRemoved={() => {}} />);
    await screen.findByText("bookings, listings");
    await act(async () => {
      fireEvent.click(screen.getByText("Remove connector"));
    });
    expect(h.calls.some((c) => c.path.endsWith("/remove"))).toBe(false);
  });
});

describe("connector status", () => {
  it("offline: last seen, the skipped-job banner and how to bring it back", async () => {
    h.respond = () => ({ status: 200, body: online({ online: false, last_seen_age: "2 hours", skipped: { feature: "Booking metrics", at: "2026-10-12T09:00:00Z", emailed: true } }) });
    render(<ConnectorStatusPanel onDone={() => {}} />);
    expect(await screen.findByText("Last seen 2 hours ago on db-box-1.")).toBeTruthy();
    expect(screen.getByText("Booking metrics skipped: connector offline")).toBeTruthy();
    expect(screen.getByText(/We emailed the owners and admins. It runs again at its next scheduled time once the connector is/)).toBeTruthy();
    expect(screen.getByText("docker restart zavi-connector")).toBeTruthy();
  });
  it("offline before the email went out -> never claims it was sent", async () => {
    h.respond = () => ({ status: 200, body: online({ online: false, last_seen_age: "1 minute", skipped: { feature: "Booking metrics", at: "2026-10-12T09:00:00Z", emailed: false } }) });
    render(<ConnectorStatusPanel onDone={() => {}} />);
    expect(await screen.findByText(/We are emailing the owners and admins./)).toBeTruthy();
    expect(document.body.textContent).not.toContain("We emailed");
  });
  it("online with no database yet -> next step on the local page", async () => {
    h.respond = () => ({ status: 200, body: online({ dialect: null }) });
    render(<ConnectorStatusPanel onDone={() => {}} />);
    expect(await screen.findByText(/Connector online on db-box-1/)).toBeTruthy();
    expect(screen.getByText(/http:\/\/localhost:7801/)).toBeTruthy();
  });
});

describe("tile", () => {
  const setup = { connected: true as const, mode: "connector" as const, dialect: "postgres" as const, legacy: false, managed_by: null, discovery: "ready" as const, settings_confirmed: true };
  it("Via Zavi Connector · <machine>, Online / Offline <age>", () => {
    expect(dbTileDescription("connector", setup, null, online() as never)).toBe("Via Zavi Connector · db-box-1");
    expect(connectorTileStatus(online() as never)).toEqual({ tone: "connected", text: "Online" });
    expect(connectorTileStatus(online({ online: false, last_seen_age: "2 hours" }) as never)).toEqual({ tone: "warning", text: "Offline 2 hours" });
    expect(whatCanLeaveText({ what_can_leave: "rows_without_blocked_columns", max_rows: 50 })).toBe("Rows, with blocked columns removed, max 50 rows");
  });
});
