// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  apiFetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
}));

import { GrowthGoals } from "./GrowthGoals";

afterEach(cleanup);

const base = { target_value: 10, baseline_value: null, due_date: "2027-01-27", status: "active", measurement_mode: "unmapped" };
const props = (items: unknown[]) =>
  ({
    goals: { max_active: 20, active_count: items.length, over_cap: false, items },
    plan: null,
    unavailable: false,
    live: { values: new Map(), states: new Map() },
    connected: [] as string[],
    onEdit: () => {},
    onCreate: () => {},
    onChanged: async () => {},
    canEdit: true,
  }) as unknown as Parameters<typeof GrowthGoals>[0];

describe("a goal Zavi cannot count yet", () => {
  it("shows the aim, 'Not counted yet' and the founder's range, with no no-number note", () => {
    const lead = { ...base, id: "g-1", objective: "Reach 10 new paying customers a month", target_metric: "new_customers", current_value: null, priority: 50, founder_estimate: "You told me 6-20 new customers last month" };
    const other = { ...base, id: "g-2", objective: "Reach 60 signups a month", target_metric: "signups", current_value: null, priority: 10, founder_estimate: null };
    render(<GrowthGoals {...props([lead, other])} />);
    expect(screen.getAllByText(/Not counted yet/)).toHaveLength(2);
    expect(screen.getByText("You told me 6-20 new customers last month.")).toBeTruthy();
    expect(screen.getAllByText(/You told me/)).toHaveLength(1);
    expect(screen.queryByText(/no number yet/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "How goals get a number" })).toBeNull();
    expect(screen.getAllByRole("progressbar")[0].getAttribute("aria-valuetext")).toBe("Not counted yet");
  });

  it("a goal with a real number shows it as before", () => {
    const counted = { ...base, id: "g-3", objective: "Reach 10 new paying customers a month", target_metric: "new_customers", current_value: 4, current_value_at: new Date().toISOString(), measurement_mode: "manual_reported", priority: 50, founder_estimate: null };
    render(<GrowthGoals {...props([counted])} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("40%");
    expect(screen.getByText(/entered today by you/)).toBeTruthy();
    expect(screen.queryByText(/Not counted yet/)).toBeNull();
    expect(screen.queryByText(/You told me/)).toBeNull();
  });
});
