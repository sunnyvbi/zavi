// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const ws = vi.hoisted(() => ({ role: "owner" as string, seedComposer: vi.fn() }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspace: () => ws }));
const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => api);
const db = vi.hoisted(() => ({ requestAccess: vi.fn() }));
vi.mock("../../settings/database/databaseApi", () => db);

import { ConnectorOfflineNotice } from "../../chat/ConnectorOfflineNotice";
import { ConnectDatabaseCard } from "../ConnectDatabaseCard";
import {
  ANSWER_WITHOUT_DATA_TEXT,
  lastSeenLine,
  parseConnectorOffline,
  parseDbNotConnected,
} from "../dbChatCards";

const NOW = Date.parse("2026-10-12T12:00:00Z");

beforeEach(() => {
  ws.role = "owner";
  ws.seedComposer.mockReset();
  api.apiFetch.mockReset();
  api.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ connectors: [] }) });
  db.requestAccess.mockReset();
  window.history.replaceState(null, "", "/workspace");
});
afterEach(cleanup);

describe("card meta parsing", () => {
  it("reads the offline machine and time, and the question to retry", () => {
    expect(parseConnectorOffline({ connector_offline: { machine: "mac-mini", last_seen_at: "2026-10-12T10:00:00Z" } }, "How many bookings?")).toEqual({
      machine: "mac-mini",
      lastSeenAt: "2026-10-12T10:00:00Z",
      retryText: "How many bookings?",
    });
  });
  it("anything malformed is no card", () => {
    expect(parseConnectorOffline({}, "q")).toBeUndefined();
    expect(parseConnectorOffline({ connector_offline: "yes" }, "q")).toBeUndefined();
    expect(parseConnectorOffline({ connector_offline: { machine: 5, last_seen_at: "not a date" } }, " ")).toEqual({ machine: null, lastSeenAt: null, retryText: null });
    expect(parseDbNotConnected({ db_not_connected: "true" })).toBeUndefined();
    expect(parseDbNotConnected({ db_not_connected: true })).toBe(true);
  });
  it("says what is known about when it was last seen", () => {
    expect(lastSeenLine({ machine: "mac-mini", lastSeenAt: "2026-10-12T10:00:00Z" }, NOW)).toBe("Last seen 2 hours ago on mac-mini.");
    expect(lastSeenLine({ machine: null, lastSeenAt: "2026-10-12T11:59:00Z" }, NOW)).toBe("Last seen 1 minute ago.");
    expect(lastSeenLine({ machine: "box", lastSeenAt: null }, NOW)).toBe("Last seen on box.");
    expect(lastSeenLine({ machine: null, lastSeenAt: null }, NOW)).toBe("It has not checked in yet.");
  });
});

describe("ConnectorOfflineNotice", () => {
  const info = { machine: "mac-mini", lastSeenAt: new Date(Date.now() - 2 * 3600_000).toISOString(), retryText: "How many bookings?" };

  it("Retry re-sends the question; Answer without your data sends the fixed line; one click only", () => {
    const { getByText, getByRole } = render(<ConnectorOfflineNotice info={info} agentSlug="operator" isLast />);
    expect(getByText("Your connector is offline")).toBeTruthy();
    expect(getByText(/Last seen 2 hours ago on mac-mini\. Retry once it is back/)).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Retry" }));
    expect(ws.seedComposer).toHaveBeenCalledWith({ agentSlug: "operator", text: "How many bookings?", autoSend: true });
    fireEvent.click(getByRole("button", { name: "Answer without your data" }));
    expect(ws.seedComposer).toHaveBeenCalledTimes(1);
  });

  it("Answer without your data", () => {
    const { getByRole } = render(<ConnectorOfflineNotice info={{ ...info, retryText: null }} agentSlug="operator" isLast />);
    expect((getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(getByRole("button", { name: "Answer without your data" }));
    expect(ws.seedComposer).toHaveBeenCalledWith({ agentSlug: "operator", text: ANSWER_WITHOUT_DATA_TEXT, autoSend: true });
  });

  it("an older reply keeps the text but offers no buttons", () => {
    const { queryByRole, getByText } = render(<ConnectorOfflineNotice info={info} agentSlug="operator" isLast={false} />);
    expect(getByText("Your connector is offline")).toBeTruthy();
    expect(queryByRole("button")).toBeNull();
  });
});

describe("ConnectDatabaseCard", () => {
  it("owner: Connect your database opens Connectors on the database tile", () => {
    const hashes: string[] = [];
    const onHash = () => hashes.push(window.location.hash);
    window.addEventListener("hashchange", onHash);
    const { getByText, getByRole } = render(<ConnectDatabaseCard />);
    expect(getByText("Connect your database to answer this")).toBeTruthy();
    expect(getByText("Zavi only reads. It takes about 5 minutes. This opens Connectors.")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Connect your database" }));
    window.removeEventListener("hashchange", onHash);
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe("/workspace?tab=brain#connector-operator_db");
    expect(hashes).toEqual(["#connector-operator_db"]);
  });

  it("member: asks an owner or admin and sends one request", async () => {
    ws.role = "member";
    db.requestAccess.mockResolvedValueOnce({ ok: true, sent: true, already_requested: false });
    const { getByText, getByRole } = render(<ConnectDatabaseCard />);
    expect(getByText("Ask an owner or admin to connect your database")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Request access" }));
    await waitFor(() => expect(getByRole("button", { name: "Request sent" })).toBeTruthy());
    expect((getByRole("button", { name: "Request sent" }) as HTMLButtonElement).disabled).toBe(true);
    expect(db.requestAccess).toHaveBeenCalledTimes(1);
  });

  it("member: a failed request says so and can be tried again", async () => {
    ws.role = "member";
    db.requestAccess.mockRejectedValueOnce(new Error("x"));
    const { getByRole, findByRole } = render(<ConnectDatabaseCard />);
    fireEvent.click(getByRole("button", { name: "Request access" }));
    expect((await findByRole("alert")).textContent).toContain("Could not send the request");
    expect((getByRole("button", { name: "Request access" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("once a database is connected the card shrinks to one line", async () => {
    api.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ connectors: [{ slug: "operator_db" }] }) });
    const { findByText, queryByTestId } = render(<ConnectDatabaseCard />);
    expect(await findByText("Your database is connected. Ask again to use it.")).toBeTruthy();
    expect(queryByTestId("connect-database-card")).toBeNull();
  });
});
