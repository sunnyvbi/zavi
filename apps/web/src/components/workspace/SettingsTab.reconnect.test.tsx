// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConnectorRowView } from "./SettingsTab";

const apiFetch = vi.fn();
const showConnectorError = vi.fn();

vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("./settings/connectorErrorDialog", () => ({
  showConnectorError: (...args: unknown[]) => showConnectorError(...args),
}));

beforeEach(() => {
  apiFetch.mockReset();
  showConnectorError.mockReset();
});
afterEach(cleanup);

function openReconnect() {
  fireEvent.click(screen.getByRole("button", { name: /manage/i }));
  fireEvent.click(screen.getByRole("menuitem", { name: /reconnect/i }));
}

describe("ConnectorRowView — Manage → Reconnect", () => {
  it("surfaces a 503 start as an error dialog instead of doing nothing", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        error: {
          code: "connector_misconfigured",
          message: "This connector isn’t available yet.",
        },
      }),
    });

    render(
      <ConnectorRowView
        row={{ slug: "x_social", connected: true, team_name: "@DeveloperZavi" }}
        readOnly={false}
        flashConnected={false}
      />,
    );
    openReconnect();

    await waitFor(() => expect(showConnectorError).toHaveBeenCalledTimes(1));
    expect(showConnectorError.mock.calls[0][0]).toMatchObject({
      message: "This connector isn’t available yet.",
    });
  });

  it("does not fire the dialog when the start succeeds", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ oauth_url: "https://x.com/i/oauth2/authorize?x=1" }),
    });

    render(
      <ConnectorRowView
        row={{ slug: "x_social", connected: true, team_name: "@DeveloperZavi" }}
        readOnly={false}
        flashConnected={false}
      />,
    );
    openReconnect();

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(showConnectorError).not.toHaveBeenCalled();
  });
});
