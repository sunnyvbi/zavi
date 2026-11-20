// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const resp: { ok: boolean; body: unknown } = { ok: true, body: {} };
vi.mock("@/lib/api", () => ({
  apiFetch: () => Promise.resolve({ ok: resp.ok, json: () => Promise.resolve(resp.body) }),
}));

vi.mock("./EmailAllowlistPanel", () => ({
  EmailAllowlistPanel: ({ canEdit }: { canEdit: boolean }) => (
    <div data-testid="allowlist-panel" data-can-edit={String(canEdit)}>
      <button type="button">Add sender</button>
    </div>
  ),
}));

import { EmailTile } from "./EmailTile";

beforeEach(() => {
  resp.ok = true;
  resp.body = {};
});
afterEach(cleanup);

describe("EmailTile", () => {
  it("shows the agent address, and Settings opens the email panel in place", async () => {
    resp.body = { address: "acme@inbox.zaviagent.com" };
    render(<EmailTile />);
    await waitFor(() => expect(screen.getByText("acme@inbox.zaviagent.com")).toBeDefined());
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog", { name: "Email settings" })).toBeDefined();
    expect(screen.getByTestId("allowlist-panel").dataset.canEdit).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the panel read-only for a member", async () => {
    resp.body = { address: "acme@inbox.zaviagent.com" };
    render(<EmailTile readOnly />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("allowlist-panel").dataset.canEdit).toBe("false");
  });

  it("says not set up when the tenant has no address, and still links to Settings", async () => {
    resp.body = { address: null, addresses: [] };
    render(<EmailTile />);
    await waitFor(() => expect(screen.getByText("Not set up yet")).toBeDefined());
    expect(screen.getByRole("button", { name: "Settings" })).toBeDefined();
  });

  it("falls back to not-set-up on a failed load rather than spinning forever", async () => {
    resp.ok = false;
    render(<EmailTile />);
    await waitFor(() => expect(screen.getByText("Not set up yet")).toBeDefined());
  });

  it("the settings dialog takes focus, keeps Tab inside, and gives focus back on close", async () => {
    resp.body = { address: "acme@inbox.zaviagent.com" };
    render(<EmailTile />);
    await waitFor(() => expect(screen.getByText("acme@inbox.zaviagent.com")).toBeDefined());
    const opener = screen.getByRole("button", { name: "Settings" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Email settings" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    const close = screen.getByRole("button", { name: "Close email settings" });
    const last = screen.getByRole("button", { name: "Add sender" });
    last.focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Settings" }));
  });

  it("its close button is a 44px touch target", () => {
    render(<EmailTile />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("button", { name: "Close email settings" }).className).toMatch(/h-11 w-11/);
  });
});
