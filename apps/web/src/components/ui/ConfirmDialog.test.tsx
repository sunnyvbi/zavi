import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfirmDialogHost, confirmAction } from "./ConfirmDialog";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const open = () =>
  confirmAction({
    title: "Disconnect X?",
    description: "Agents will stop posting to this account.",
    confirmLabel: "Disconnect",
    tone: "danger",
  });

describe("confirmAction", () => {
  it("resolves true when the confirm button is pressed", async () => {
    render(<ConfirmDialogHost />);
    const answer = open();
    const button = await screen.findByRole("button", { name: "Disconnect" });
    fireEvent.click(button);
    await expect(answer).resolves.toBe(true);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("dismisses on a backdrop click", async () => {
    render(<ConfirmDialogHost />);
    const answer = open();
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await expect(answer).resolves.toBe(false);
  });

  it("resolves false on Cancel and on Escape", async () => {
    render(<ConfirmDialogHost />);
    const cancelled = open();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await expect(cancelled).resolves.toBe(false);

    const escaped = open();
    await screen.findByRole("alertdialog");
    fireEvent.keyDown(document, { key: "Escape" });
    await expect(escaped).resolves.toBe(false);
  });

  it("labels the dialog with its title and focuses the confirm button", async () => {
    render(<ConfirmDialogHost />);
    void open();
    const dialog = await screen.findByRole("alertdialog");
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent).toBe("Disconnect X?");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Disconnect" }),
    );
  });

  it("renders inside the workspace shell so the dark rules reach it", async () => {
    const shell = document.createElement("div");
    shell.className = "workspace-shell";
    document.body.appendChild(shell);
    render(<ConfirmDialogHost />);
    void open();
    expect(shell.contains(await screen.findByRole("alertdialog"))).toBe(true);
  });

  it("falls back to window.confirm when no host is mounted", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    await expect(open()).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith(
      "Disconnect X?\n\nAgents will stop posting to this account.",
    );
    vi.unstubAllGlobals();
  });
});
