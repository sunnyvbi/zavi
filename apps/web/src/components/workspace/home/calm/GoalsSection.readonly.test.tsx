// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GoalsSection } from "./GoalsSection";

afterEach(cleanup);

describe("GoalsSection", () => {
  it("offers New goal only with an add handler", () => {
    const { rerender } = render(<GoalsSection goals={[]} />);
    expect(screen.queryByRole("button", { name: /New goal/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Set your first goal/ })).toBeNull();
    expect(screen.getByText("No goals yet. An owner or admin sets them.")).toBeTruthy();
    rerender(<GoalsSection goals={[]} onAddGoal={vi.fn()} />);
    expect(screen.getByRole("button", { name: /New goal/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Set your first goal/ })).toBeTruthy();
  });
});
