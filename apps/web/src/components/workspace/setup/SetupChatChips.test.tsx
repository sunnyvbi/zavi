// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
const seedComposer = vi.fn();
vi.mock("../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ seedComposer }) }));
import { SetupChatChips } from "./SetupChatChips";
afterEach(cleanup);

describe("SetupChatChips", () => {
  it("a chip sends its question to the growth officer's chat (free during setup)", () => {
    render(<SetupChatChips tabId="growth" />);
    fireEvent.click(screen.getByRole("button", { name: "Is my data safe?" }));
    expect(seedComposer).toHaveBeenCalledWith({ agentSlug: "cgo", tabId: "growth", text: "Is my data safe?", autoSend: true });
  });
});
