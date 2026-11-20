// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { SummonedSurface } from "./SummonedSurface";

vi.mock("./agent/EngineerDashboard", () => ({
  EngineerDashboard: () => <div data-testid="engineer-dashboard" />,
}));

const builds = {
  key: "builds",
  dashboardSlug: "engineer",
  label: "Your builds",
};

afterEach(() => cleanup());

describe("SummonedSurface", () => {
  it("mounts the registered panel inline, labelled as Zavi's own", () => {
    render(<SummonedSurface surface={builds} />);
    expect(screen.getByTestId("engineer-dashboard")).toBeTruthy();
    expect(screen.getByText("Your builds")).toBeTruthy();
    expect(screen.getByText(/Opened here by Zavi/i)).toBeTruthy();
  });

  it("renders nothing for a key the client does not recognise", () => {
    const { container } = render(
      <SummonedSurface surface={{ ...builds, key: "not-a-surface" }} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("collapses and re-expands, and the state is component-local only", () => {
    render(<SummonedSurface surface={builds} />);
    const toggle = screen.getByRole("button", { name: "Hide" });
    fireEvent.click(toggle);
    expect(screen.queryByTestId("engineer-dashboard")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByTestId("engineer-dashboard")).toBeTruthy();
    cleanup();
    render(<SummonedSurface surface={builds} />);
    expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
  });

  it("DESIGN GUARD: offers no way to pin, navigate to, or persist the surface", () => {
    const { container } = render(<SummonedSurface surface={builds} />);
    expect(container.querySelectorAll("a").length).toBe(0);
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.length).toBe(1);
    expect(buttons[0].textContent).toBe("Hide");
  });
});
