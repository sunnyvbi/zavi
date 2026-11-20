// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => ({}) }));
const setupValue = vi.hoisted(() => ({
  current: null as null | { locked: boolean; state: unknown; canManageSetup: boolean; buildOpen: boolean },
}));
vi.mock("../setup/SetupProvider", () => ({ useSetupOptional: () => setupValue.current }));
import { NavItem } from "./ContextPanel";

afterEach(() => {
  cleanup();
  setupValue.current = null;
});

const SETUPS = [
  ["running for an owner", { locked: true, state: { enabled: true, done: false }, canManageSetup: true, buildOpen: false }],
  ["still loading for an owner", { locked: false, state: null, canManageSetup: true, buildOpen: false }],
  ["failed to load for an owner", { locked: true, state: null, canManageSetup: true, buildOpen: false }],
] as const;

describe("NavItem never carries a setup lock", () => {
  it.each(SETUPS)("setup %s: the row is enabled, unlabelled by any lock, and navigates on click", (_label, setup) => {
    setupValue.current = { ...setup };
    const onClick = vi.fn();
    const { container } = render(
      <NavItem label="Analytics" icon={<span />} onClick={onClick} badge={<span data-testid="badge">3</span>} />,
    );
    const btn = screen.getByRole("button", { name: /Analytics/ });
    expect(btn).toHaveProperty("disabled", false);
    expect(btn.getAttribute("aria-disabled")).toBeNull();
    expect(btn.getAttribute("aria-busy")).toBeNull();
    expect(btn.getAttribute("title")).toBeNull();
    expect(btn.className).not.toMatch(/cursor-not-allowed|opacity-40/);
    expect(container.querySelector(".lucide-lock")).toBeNull();
    expect(screen.getByTestId("badge").textContent).toBe("3");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("setup running: a new-tab row still renders as its link", () => {
    setupValue.current = { ...SETUPS[0][1] };
    const onClick = vi.fn();
    render(<NavItem label="Tutorials" icon={<span />} onClick={onClick} newTabHref="/tutorials" />);
    const link = screen.getByRole("link", { name: /Tutorials/ });
    expect(link.getAttribute("href")).toBe("/tutorials");
    fireEvent.click(link);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
