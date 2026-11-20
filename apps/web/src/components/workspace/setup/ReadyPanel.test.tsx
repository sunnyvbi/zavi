// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
const openAgentTab = vi.fn();
const mark = vi.fn(async (_m: unknown) => null);
vi.mock("../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ openAgentTab }) }));
vi.mock("./SetupProvider", () => ({ useSetupOptional: () => ({ mark, canManageSetup: true }) }));
import { ReadyPanel, showReadyPanel } from "./ReadyPanel";
afterEach(() => { cleanup(); openAgentTab.mockClear(); mark.mockClear(); });

describe("ReadyPanel", () => {
  it("Go to Home opens a fresh main Zavi chat and records the dismissal", async () => {
    render(<ReadyPanel />);
    expect(screen.getByText("Your growth strategy is ready.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Go to Home/ }));
    await waitFor(() => expect(mark).toHaveBeenCalledWith({ step: "home" }));
    await waitFor(() => expect(openAgentTab).toHaveBeenCalledWith("operator", { newThread: true, push: true }));
  });
  it("shows only to owners/admins, after setup is done, a plan exists, and Home was never pressed", () => {
    const s = { enabled: true, done: true, home_seen: false } as never;
    expect(showReadyPanel(s, true, true)).toBe(true);
    expect(showReadyPanel(s, true, false)).toBe(false);
    expect(showReadyPanel(s, false, true)).toBe(false);
    expect(showReadyPanel({ enabled: true, done: true, home_seen: true } as never, true, true)).toBe(false);
    expect(showReadyPanel({ enabled: true, done: false, home_seen: false } as never, true, true)).toBe(false);
    expect(showReadyPanel({ enabled: false }, true, true)).toBe(false);
    expect(showReadyPanel(null, true, true)).toBe(false);
  });
  it("a failed dismissal still opens Home, and the card comes back (nothing claims it was dismissed)", async () => {
    mark.mockRejectedValueOnce(new Error("403"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<ReadyPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Go to Home/ }));
    await waitFor(() => expect(openAgentTab).toHaveBeenCalled());
    warn.mockRestore();
  });
});
