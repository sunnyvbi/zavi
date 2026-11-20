// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabDescriptor } from "@/lib/workspace/types";

vi.mock("../WorkspacePane", () => ({
  WorkspacePane: ({ activeTabIdOverride }: { activeTabIdOverride: string }) => (
    <div>
      <span data-testid="drawer-content">{activeTabIdOverride}</span>
      <button type="button">Drawer action</button>
    </div>
  ),
}));

import { WorkspaceDrawer } from "./WorkspaceDrawer";

const tab = (kind: "autopilot" | "brain" | "onboarding"): TabDescriptor => ({
  id: `${kind}-default`,
  kind,
  title: kind,
  payload: { kind },
  dirty: false,
  pinned: false,
});

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorkspaceDrawer", () => {
  it.each([
    ["autopilot", "Growth"],
    ["brain", "Connectors"],
    ["onboarding", "Onboarding"],
  ] as const)("renders %s as the %s drawer", (kind, title) => {
    render(<WorkspaceDrawer tab={tab(kind)} onClose={() => {}} />);

    expect(screen.getByRole("dialog", { name: title })).toBeTruthy();
    expect(screen.getByTestId("drawer-content").textContent).toBe(`${kind}-default`);
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("translate-x-0");
    expect(dialog.className).toContain("transform-gpu");
    expect(dialog.parentElement?.className).not.toContain("backdrop-blur");
  });

  it.each(["button", "backdrop", "Escape"] as const)(
    "animates closed from the %s",
    (trigger) => {
      const onClose = vi.fn();
      const { container } = render(
        <WorkspaceDrawer tab={tab("brain")} onClose={onClose} />,
      );
      const dialog = screen.getByRole("dialog");

      if (trigger === "button") {
        fireEvent.click(screen.getByRole("button", { name: "Close Connectors" }));
      } else if (trigger === "backdrop") {
        fireEvent.mouseDown(container.firstElementChild!);
      } else {
        fireEvent.keyDown(window, { key: "Escape" });
      }

      expect(dialog.className).toContain("translate-x-full");
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.transitionEnd(dialog, { propertyName: "transform" });
      expect(onClose).toHaveBeenCalledOnce();
    },
  );

  it("does not close when the panel itself is clicked", () => {
    const onClose = vi.fn();
    render(<WorkspaceDrawer tab={tab("brain")} onClose={onClose} />);

    fireEvent.mouseDown(screen.getByRole("dialog"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes immediately when reduced motion is preferred", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const onClose = vi.fn();
    render(<WorkspaceDrawer tab={tab("brain")} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Close Connectors" }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps keyboard focus inside the drawer", () => {
    render(<WorkspaceDrawer tab={tab("brain")} onClose={() => {}} />);
    const close = screen.getByRole("button", { name: "Close Connectors" });
    const action = screen.getByRole("button", { name: "Drawer action" });

    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(action);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);
  });
});
