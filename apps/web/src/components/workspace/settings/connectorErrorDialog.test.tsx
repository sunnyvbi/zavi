// @vitest-environment jsdom

import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { act, cleanup, render, screen, fireEvent } from "@testing-library/react";
import { ConnectorErrorHost, showConnectorError } from "./connectorErrorDialog";

afterEach(() => {
  cleanup();
  document.querySelectorAll(".workspace-shell").forEach((el) => el.remove());
});

describe("ConnectorErrorHost", () => {
  it("mounts inside the workspace shell so the dark theme tokens apply", async () => {
    const shell = document.createElement("div");
    shell.className = "workspace-shell";
    document.body.appendChild(shell);
    render(React.createElement(ConnectorErrorHost));

    await act(async () => {
      showConnectorError({ title: "Couldn’t connect SendGrid", message: "Could not save the SendGrid connection." });
    });

    const dialog = screen.getByRole("alertdialog", { name: "Couldn’t connect SendGrid" });
    expect(shell.contains(dialog)).toBe(true);
    expect(dialog.textContent).toContain("Could not save the SendGrid connection.");
  });

  it("falls back to the body outside the workspace and closes on Got it", async () => {
    render(React.createElement(ConnectorErrorHost));

    await act(async () => {
      showConnectorError({ message: "Boom" });
    });

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.parentElement).toBe(document.body);

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
