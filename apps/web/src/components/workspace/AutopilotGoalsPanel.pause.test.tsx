// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  apiFetch: async () => ({ ok: true, status: 200, json: async () => ({ measured: false }) }) as unknown as Response,
}));

import { GoalEditor, type Goal } from "./AutopilotGoalsPanel";

afterEach(cleanup);

const goal: Goal = {
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

describe("GoalEditor Pause", () => {
  it("offers Pause goal only when the caller passes onPause, and calls it", async () => {
    const onPause = vi.fn(async () => {});
    render(<GoalEditor goal={goal} onClose={() => {}} onSaved={async () => {}} onPause={onPause} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause goal" }));
    expect(onPause).toHaveBeenCalledTimes(1);
    cleanup();
    render(<GoalEditor goal={goal} onClose={() => {}} onSaved={async () => {}} />);
    expect(screen.queryByRole("button", { name: "Pause goal" })).toBeNull();
  });

  it("shows a failed pause as the form's error", async () => {
    const onPause = vi.fn(async () => {
      throw new Error("Could not pause that goal.");
    });
    render(<GoalEditor goal={goal} onClose={() => {}} onSaved={async () => {}} onPause={onPause} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause goal" }));
    expect(await screen.findByText("Could not pause that goal.")).toBeTruthy();
  });
});
