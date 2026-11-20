// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { GoalsSection } from "./GoalsSection";
import type { HomeGoal } from "./calmTypes";

afterEach(cleanup);

const goal = (over: Partial<HomeGoal>): HomeGoal => ({
  id: "g",
  objective: "Grow MRR",
  target_metric: "mrr",
  target_value: 100000,
  baseline_value: null,
  current_value: 900,
  due_date: null,
  status: "active",
  priority: 50,
  source: "founder",
  ...over,
});

describe("Home goal data source", () => {
  it("shows Stripe for an MRR goal Stripe measures", () => {
    render(<GoalsSection goals={[goal({ measurement_mode: "auto" })]} onAddGoal={() => {}} />);
    expect(within(screen.getByRole("article", { name: "Grow MRR" })).getByText("Stripe")).toBeTruthy();
  });

  it("says the founder enters a manual goal's number, even for MRR", () => {
    render(<GoalsSection goals={[goal({ measurement_mode: "manual_reported" })]} onAddGoal={() => {}} />);
    const card = screen.getByRole("article", { name: "Grow MRR" });
    expect(within(card).getByText("From you")).toBeTruthy();
    expect(within(card).queryByText("Stripe")).toBeNull();
  });
});
