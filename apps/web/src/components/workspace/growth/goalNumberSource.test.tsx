// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { GrowthGoal } from "@/lib/workspace/useGrowthPlan";
import { GrowthGoals, goalNumberSource } from "./GrowthGoals";

afterEach(cleanup);

const NOW = new Date("2026-09-28T12:00:00Z");
const g = (over: Partial<GrowthGoal>): GrowthGoal =>
  ({
    id: "g",
    objective: "Grow hosts to 2,000",
    target_metric: "total_hosts",
    target_value: 2000,
    baseline_value: null,
    current_value: 612,
    due_date: "2026-12-31",
    status: "active",
    priority: 1,
    source: "founder",
    falsifier: null,
    status_changed_by: null,
    status_changed_at: null,
    measurement_mode: "manual_reported",
    ...over,
  }) as GrowthGoal;

describe("goalNumberSource", () => {
  it("a typed number says when the founder entered it", () => {
    expect(goalNumberSource(g({ current_value_at: "2026-09-08T20:11:00Z" }), NOW)).toBe("entered 20 days ago by you");
    expect(goalNumberSource(g({ current_value_at: "2026-09-27T08:00:00Z" }), NOW)).toBe("entered 1 day ago by you");
    expect(goalNumberSource(g({ current_value_at: "2026-09-28T08:00:00Z" }), NOW)).toBe("entered today by you");
    expect(goalNumberSource(g({ current_value_at: null }), NOW)).toBe("entered by you");
  });

  it("a counted goal says how it is counted, and when the last count failed", () => {
    const counted = { counted_as: "hosts who ever listed a car, any listing status", current_value_at: "2026-09-28T13:30:00Z" };
    expect(goalNumberSource(g(counted), NOW)).toBe("counted daily: hosts who ever listed a car, any listing status");
    expect(goalNumberSource(g({ ...counted, count_failing: true }), NOW)).toBe(
      "counted daily: hosts who ever listed a car, any listing status (last count failed)",
    );
  });

  it("says nothing for a source-read number or no number", () => {
    expect(goalNumberSource(g({ measurement_mode: "auto" }), NOW)).toBeNull();
    expect(goalNumberSource(g({ current_value: null }), NOW)).toBeNull();
  });

  it("shows on the goal card", () => {
    render(
      <GrowthGoals
        goals={{ max_active: 3, active_count: 1, over_cap: false, items: [g({ counted_as: "hosts who ever listed a car" })] }}
        plan={null}
        unavailable={false}
        live={{ values: new Map(), states: new Map() }}
        connected={[]}
        onEdit={() => {}}
        onCreate={() => {}}
        onChanged={async () => {}}
      />,
    );
    expect(screen.getByText(/counted daily: hosts who ever listed a car/)).toBeTruthy();
  });
});
