// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  apiFetch: async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ id: "g-1", warnings: ["The goal was saved, but its current value was not."] }),
    }) as unknown as Response,
}));

import { GrowthGoals } from "./GrowthGoals";

afterEach(cleanup);

describe("GrowthGoals inline add", () => {
  it("shows the create warning after refreshing", async () => {
    const onChanged = vi.fn(async () => {});
    render(
      <GrowthGoals
        goals={{ max_active: 20, active_count: 0, over_cap: false, items: [] }}
        plan={null}
        unavailable={false}
        live={{ values: new Map(), states: new Map() }}
        connected={[]}
        onEdit={() => {}}
        onCreate={() => {}}
        onChanged={onChanged}
      />,
    );
    fireEvent.change(screen.getByLabelText("Add a goal"), { target: { value: "Grow MRR to 5000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText(/current value was not/)).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });
});

describe("GrowthGoals delete", () => {
  it("shows Edit, the bin and Add to owners and admins only; a member reads the goals", () => {
    const goal = { id: "g-1", objective: "Grow MRR to 5000", target_metric: "mrr", target_value: 5000, current_value: null, baseline_value: null, due_date: "2026-12-31", status: "active", priority: 50 };
    const props = {
      goals: { max_active: 20, active_count: 1, over_cap: false, items: [goal] },
      plan: null,
      unavailable: false,
      live: { values: new Map(), states: new Map() },
      connected: [] as string[],
      onEdit: vi.fn(),
      onCreate: () => {},
      onChanged: vi.fn(async () => {}),
    } as unknown as Parameters<typeof GrowthGoals>[0];
    const { rerender } = render(<GrowthGoals {...props} canEdit={false} />);
    expect(screen.queryByRole("button", { name: "Delete Grow MRR to 5000" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByLabelText("Add a goal")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit Grow MRR to 5000" }));
    expect(props.onEdit).not.toHaveBeenCalled();
    rerender(<GrowthGoals {...props} canEdit />);
    expect(screen.getByRole("button", { name: "Delete Grow MRR to 5000" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByLabelText("Add a goal")).toBeTruthy();
  });
});
