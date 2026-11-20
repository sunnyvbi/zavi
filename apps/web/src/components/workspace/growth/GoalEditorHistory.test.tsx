// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  apiFetch: async () => ({ ok: true, status: 200, json: async () => ({ measured: false }) }) as unknown as Response,
}));

import { GoalEditor, type Goal } from "../AutopilotGoalsPanel";

afterEach(cleanup);

const goal = {
  id: "goal-1",
  objective: "Activate more hosts",
  target_metric: "host_activation",
  target_value: 40,
  baseline_value: 20,
  current_value: 30,
  due_date: "2026-12-31",
  status: "active",
  priority: 50,
  source: "founder",
  falsifier: null,
  status_changed_by: null,
  status_changed_at: null,
  created_at: "",
  updated_at: "",
} as Goal;

describe("GoalEditor history slot", () => {
  it("renders the history it is given when editing a goal", () => {
    render(<GoalEditor goal={goal} onClose={() => {}} onSaved={async () => {}} history={<p>History of this goal</p>} />);
    expect(screen.getByTestId("goal-editor-history").textContent).toBe("History of this goal");
  });

  it("has no slot when creating, or when none is given", () => {
    render(<GoalEditor goal={null} onClose={() => {}} onSaved={async () => {}} history={<p>History of this goal</p>} />);
    expect(screen.queryByTestId("goal-editor-history")).toBeNull();
    cleanup();
    render(<GoalEditor goal={goal} onClose={() => {}} onSaved={async () => {}} />);
    expect(screen.queryByTestId("goal-editor-history")).toBeNull();
  });
});
