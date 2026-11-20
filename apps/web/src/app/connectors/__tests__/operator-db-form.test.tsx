// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OperatorDbForm, probeFailureReason } from "../OperatorDbConnectButton";
import { ConnectorRowView } from "@/components/workspace/SettingsTab";

const apiFetch = vi.fn();

vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/components/workspace/settings/connectorErrorDialog", () => ({
  showConnectorError: vi.fn(),
}));

function respond(body: unknown) {
  apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => body });
}

function submit(container: HTMLElement) {
  fireEvent.change(screen.getByPlaceholderText(/postgres:\/\//), {
    target: { value: "postgresql://sd@localhost:59999/nope?sslmode=disable" },
  });
  fireEvent.submit(container.querySelector("form")!);
}

beforeEach(() => apiFetch.mockReset());
afterEach(cleanup);

describe("OperatorDbForm — probe failure", () => {
  it("says it couldn't connect, never 'Connected', never the raw error", async () => {
    respond({ ok: false, type: "postgres", discovery_error: "AggregateError" });
    const onConnected = vi.fn();
    const { container } = render(
      <OperatorDbForm onClose={() => {}} onConnected={onConnected} />,
    );
    submit(container);

    await screen.findByText("Couldn't connect to your database");
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/connected,/i);
    expect(text).not.toContain("AggregateError");
    expect(text).toContain("Check the host, port and credentials, then try again.");
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("maps common driver errors to a short plain reason", () => {
    expect(probeFailureReason("AggregateError")).toBe(
      "Nothing answered at that host and port.",
    );
    expect(probeFailureReason('password authentication failed for user "x"')).toBe(
      "The username or password was rejected.",
    );
    expect(probeFailureReason("UnrecognizedClientException")).toBe(
      "The username or password was rejected.",
    );
    expect(probeFailureReason("something odd")).toBeNull();
  });
});

describe("Operator DB tile", () => {
  it("shows Connected as soon as the form saves the connection", async () => {
    respond({ ok: true, type: "postgres", write_capable: "false", discovery: "pending" });
    const { container } = render(
      <ConnectorRowView
        row={{ slug: "operator_db", connected: false }}
        readOnly={false}
        flashConnected={false}
      />,
    );
    expect(container.textContent).toContain("Not connected");
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    submit(container);

    await waitFor(() => expect(container.textContent).not.toContain("Not connected"));
    expect(container.textContent).toContain("Connected");
  });

  it("says Zavi set it up when the database is the founder's own built app", () => {
    const { container } = render(
      <ConnectorRowView
        row={{ slug: "operator_db", connected: true, db_type: "postgres", managed_by: "zavi" }}
        readOnly={false}
        flashConnected={false}
      />,
    );
    expect(container.textContent).toContain("Your app's database, set up by Zavi");
  });

  it("keeps showing the database type for a founder-connected database", () => {
    const { container } = render(
      <ConnectorRowView
        row={{ slug: "operator_db", connected: true, db_type: "postgres" }}
        readOnly={false}
        flashConnected={false}
      />,
    );
    expect(container.textContent).toContain("Postgres");
    expect(container.textContent).not.toContain("set up by Zavi");
  });
});
