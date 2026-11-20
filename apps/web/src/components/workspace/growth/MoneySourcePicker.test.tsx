// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GrowthGoal } from "@/lib/workspace/useGrowthPlan";

const calls: Array<{ path: string; method?: string; body?: string }> = [];
let candidates: unknown = [
  { source: "booking_value", label: "Bookings database", definition: "Booking value from your bookings database, net of refunds", value_30d_usd: 52400 },
  { source: "stripe_gross_revenue", label: "Stripe", definition: "Gross charges in Stripe, incl. deposits and fees", value_30d_usd: 61250.5 },
];
vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string, opts?: { method?: string; body?: string }) => {
    calls.push({ path, method: opts?.method, body: opts?.body });
    if (path.includes("/current-value")) {
      return { ok: true, status: 200, json: async () => ({ measured: false, reason: "pick_money_source", candidates }) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
  },
}));

import { COPY, MoneySourcePicker } from "./MoneySourcePicker";
import { liveKey, withLiveValue } from "./GrowthGoals";

const goal = (over: Partial<GrowthGoal> = {}): GrowthGoal =>
  ({
    id: "g-1",
    objective: "Grow monthly booking value",
    target_metric: "gmv",
    target_value: 300000,
    baseline_value: null,
    current_value: null,
    due_date: null,
    status: "active",
    priority: 1,
    source: null,
    falsifier: null,
    status_changed_by: null,
    status_changed_at: null,
    measurement_mode: "manual_reported",
    measure_source: null,
    ...over,
  }) as GrowthGoal;
const onChanged = vi.fn(async () => {});

beforeEach(() => {
  calls.length = 0;
  onChanged.mockClear();
  candidates = [
    { source: "booking_value", label: "Bookings database", definition: "Booking value from your bookings database, net of refunds", value_30d_usd: 52400 },
    { source: "stripe_gross_revenue", label: "Stripe", definition: "Gross charges in Stripe, incl. deposits and fees", value_30d_usd: 61250.5 },
  ];
});
afterEach(cleanup);

describe("MoneySourcePicker", () => {
  it("must catch: two sources show side by side, and a pick PATCHes measure_source with auto mode", async () => {
    render(<MoneySourcePicker goal={goal()} canEdit onChanged={onChanged} />);
    expect(await screen.findByText(COPY.heading)).toBeTruthy();
    expect(screen.getByText("Booking value from your bookings database, net of refunds")).toBeTruthy();
    expect(screen.getByText("$52,400 in the last 30 days")).toBeTruthy();
    expect(screen.getByText("$61,250.50 in the last 30 days")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `${COPY.use}: Stripe` }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/api/workspace/autopilot/goals/g-1");
    expect(JSON.parse(patch.body!)).toEqual({ measure_source: "stripe_gross_revenue", measurement_mode: "auto" });
  });

  it("a picked goal says where it is measured from, and Change source re-opens the choice", async () => {
    render(<MoneySourcePicker goal={goal({ measure_source: "booking_value", measurement_mode: "auto" })} canEdit onChanged={onChanged} />);
    expect(screen.getByText(/Measured from Bookings database\./)).toBeTruthy();
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: COPY.change }));
    expect(await screen.findByText(COPY.heading)).toBeTruthy();
  });

  it("a manual goal with a leftover pick is not 'measured from' the pick: the choice shows again", async () => {
    render(<MoneySourcePicker goal={goal({ measure_source: "booking_value", measurement_mode: "manual_reported" })} canEdit onChanged={onChanged} />);
    expect(await screen.findByText(COPY.heading)).toBeTruthy();
    expect(screen.queryByText(/Measured from/)).toBeNull();
  });

  it("must not catch: one source (no candidates) shows nothing", async () => {
    candidates = [];
    render(<MoneySourcePicker goal={goal()} canEdit onChanged={onChanged} />);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(screen.queryByText(COPY.heading)).toBeNull();
  });

  it("must not catch: a count goal (bookings) never shows the picker", () => {
    render(<MoneySourcePicker goal={goal({ target_metric: "bookings" })} canEdit onChanged={onChanged} />);
    expect(calls).toHaveLength(0);
    expect(screen.queryByText(COPY.heading)).toBeNull();
  });

  it("a member (cannot edit) sees the source but no picker or link", () => {
    render(<MoneySourcePicker goal={goal({ measure_source: "stripe_gross_revenue", measurement_mode: "auto" })} canEdit={false} onChanged={onChanged} />);
    expect(screen.getByText(/Measured from Stripe\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: COPY.change })).toBeNull();
  });
});

describe("live values per pick", () => {
  it("two goals on one metric with different picks each get their own live value", () => {
    const a = goal({ id: "a", measure_source: "booking_value", measurement_mode: "auto" });
    const b = goal({ id: "b", measure_source: "stripe_gross_revenue", measurement_mode: "auto" });
    const live = new Map([[liveKey(a), 52400], [liveKey(b), 61250.5]]);
    expect(withLiveValue(a, live).current_value).toBe(52400);
    expect(withLiveValue(b, live).current_value).toBe(61250.5);
  });
});
