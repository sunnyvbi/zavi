
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, within } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { GoalHistory, goalPace } from "./GoalHistory";
import type { GrowthGoal } from "@/lib/workspace/useGrowthPlan";

const NOW = Date.parse("2026-09-28T12:00:00Z");

const goal: GrowthGoal = {
  id: "95c06147-8334-49b0-a335-c305b85193aa",
  objective: "Grow MRR to 3,000",
  target_metric: "mrr",
  target_value: 3000,
  baseline_value: null,
  current_value: 1290,
  due_date: "2026-12-31",
  status: "active",
  priority: 50,
  source: null,
  falsifier: null,
  status_changed_by: null,
  status_changed_at: null,
  measurement_mode: "auto",
};

const fmt = (v: number) => `$${Math.round(v).toLocaleString()}`;

beforeEach(() => apiFetch.mockReset());
afterEach(cleanup);

describe("goalPace", () => {
  const points = [
    { at: "2026-09-01T00:00:00Z", value: 1000 },
    { at: "2026-09-28T00:00:00Z", value: 1290 },
  ];
  it("compares today's number to the straight line to the target", () => {
    const p = goalPace(points, goal, NOW, 1290);
    expect(p).not.toBeNull();
    expect(Math.round(p!.expected)).toBeGreaterThan(1400);
    expect(p!.onPace).toBe(false);
    expect(p!.daysLeft).toBe(95);
  });
  it("handles a goal where lower is better", () => {
    const p = goalPace(
      [
        { at: "2026-09-01T00:00:00Z", value: 10 },
        { at: "2026-09-28T00:00:00Z", value: 6 },
      ],
      { target_value: 5, due_date: "2026-10-31" },
      NOW,
      6,
    );
    expect(p!.onPace).toBe(true);
  });
  it("is null without a target, a due date or a reading", () => {
    expect(goalPace(points, { target_value: null, due_date: "2026-12-31" }, NOW, 1)).toBeNull();
    expect(goalPace(points, { target_value: 1, due_date: null }, NOW, 1)).toBeNull();
    expect(goalPace([], goal, NOW, 1)).toBeNull();
  });
});

describe("GoalHistory", () => {
  it("draws the readings, the pace and a receipt chip", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        goal_id: goal.id,
        metric_key: "stripe_mrr",
        label: "MRR",
        source: "stripe",
        window_kind: "point",
        unit: "usd",
        direction: "up",
        points: [
          { at: "2026-09-01T00:00:00Z", value: 1000 },
          { at: "2026-09-28T00:00:00Z", value: 1290 },
        ],
        last_measured_at: "2026-09-28T05:41:25Z",
      }),
    });
    const { container, findByText } = render(<GoalHistory goal={goal} format={fmt} now={NOW} />);
    expect(await findByText(/Behind pace: about/)).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledWith(`/api/workspace/autopilot/goals/${goal.id}/history`);
    expect(within(container).getByTestId("receipt-chip").textContent).toContain("Stripe");
    expect(container.querySelector('svg[role="img"]')).toBeTruthy();
  });

  it("keeps the layout with empty slots when there is no history", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ goal_id: goal.id, metric_key: null, points: [], last_measured_at: null }) });
    const { container, findByText } = render(<GoalHistory goal={goal} format={fmt} now={NOW} />);
    expect(await findByText("No history yet.")).toBeTruthy();
    expect(within(container).getAllByText("No data")).toHaveLength(3);
    expect(within(container).queryByTestId("receipt-chip")).toBeNull();
  });

  it("says on track when nothing is short, even a hair behind the line", async () => {
    const signups: GrowthGoal = { ...goal, objective: "Signups to 100", target_metric: "signups", target_value: 100, current_value: 0, due_date: "2026-10-30", measurement_mode: "manual_reported" };
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ goal_id: goal.id, metric_key: `goal:${goal.id}`, source: "founder_reported", points: [{ at: "2026-09-28T11:00:00Z", value: 0 }], last_measured_at: "2026-09-28T11:00:00Z" }),
    });
    const { findByText, queryByText } = render(<GoalHistory goal={signups} format={(v) => String(Math.round(v))} onAsk={() => {}} now={NOW} />);
    expect(await findByText("On track to hit the goal.")).toBeTruthy();
    expect(queryByText(/Behind pace/)).toBeNull();
    expect(queryByText("Ask Zavi what is driving it")).toBeTruthy();
  });

  it("reads the history again when the saved goal changes", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ goal_id: goal.id, metric_key: null, points: [], last_measured_at: null }) });
    const { rerender, findByText } = render(<GoalHistory goal={goal} format={fmt} now={NOW} />);
    await findByText("No history yet.");
    rerender(<GoalHistory goal={{ ...goal, current_value: 1500 }} format={fmt} now={NOW} />);
    await findByText("No history yet.");
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("says so when the read fails, never an empty history", async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const { findByText } = render(<GoalHistory goal={goal} format={fmt} now={NOW} />);
    expect(await findByText("History could not be loaded.")).toBeTruthy();
  });
});

describe("the server's trajectory decides the verdict", () => {
  const history = { goal_id: goal.id, metric_key: null, source: "founder_reported", points: [{ at: "2026-09-20T00:00:00Z", value: 1000 }, { at: "2026-09-27T00:00:00Z", value: 1290 }], last_measured_at: "2026-09-27T00:00:00Z" };
  const typed = { ...goal, measurement_mode: "manual_reported", baseline_value: 900 };
  it("a number that could be either reading says how to fix it, not 'add a target and a due date'", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => history });
    const g = { ...typed, trajectory: { kind: "ambiguous" as const, progress: null, line: null, projected: null, behind_required: false, reading_day: "2026-09-27", pace_usable: true } };
    const { findByText, queryByText } = render(<GoalHistory goal={g} format={fmt} now={NOW} />);
    expect(await findByText("No pace yet.")).toBeTruthy();
    expect(queryByText(/Add a target and a due date/)).toBeNull();
  });
  it("an old number is not called behind by the browser's clock", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => history });
    const line = { start_value: 0, start_day: "2026-09-01", target: 3000, due_day: "2026-12-31" };
    const g = { ...typed, trajectory: { kind: "period_total" as const, progress: 0.43, line, projected: null, behind_required: false, reading_day: "2026-09-27", pace_usable: false } };
    const { findByText, queryByText } = render(<GoalHistory goal={g} format={fmt} now={NOW} />);
    expect(await findByText("No pace from an old number.")).toBeTruthy();
    expect(queryByText(/Behind pace/)).toBeNull();
  });
});

describe("history states the server's trajectory can be in", () => {
  const history = { goal_id: goal.id, metric_key: null, source: "founder_reported", points: [{ at: "2026-09-20T00:00:00Z", value: 1000 }, { at: "2026-09-27T00:00:00Z", value: 1290 }], last_measured_at: "2026-09-27T00:00:00Z" };
  const line = { start_value: 0, start_day: "2026-09-01", target: 3000, due_day: "2026-12-31" };
  it("an old reading on a connected goal waits for the source, it does not ask the founder to type a number", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => history });
    const g = { ...goal, trajectory: { kind: "gauge" as const, progress: 0.43, line, projected: null, behind_required: false, reading_day: "2026-09-20", pace_usable: false } };
    const { findByText, queryByText } = render(<GoalHistory goal={g} format={fmt} now={NOW} />);
    expect(await findByText(/connected source has not measured it recently/)).toBeTruthy();
    expect(queryByText(/Enter today's number/)).toBeNull();
  });
  it("a period total whose due date moved before its start says so, not 'add a target and a due date'", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => history });
    const g = { ...goal, measurement_mode: "manual_reported", trajectory: { kind: "period_total" as const, progress: 0.43, line: null, projected: null, behind_required: false, reading_day: "2026-09-27", pace_usable: true } };
    const { findByText, queryByText } = render(<GoalHistory goal={g} format={fmt} now={NOW} />);
    expect(await findByText("No pace line.")).toBeTruthy();
    expect(queryByText(/Add a target and a due date/)).toBeNull();
  });
});
