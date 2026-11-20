import { describe, expect, it, vi } from "vitest";

const rpc = vi.fn(async () => ({ error: null }));
const goals = [{ id: "g-1", target_metric: "gmv", created_at: "2026-10-01T00:00:00Z", measure_source: "booking_value" }];
const chain = {
  select: () => chain,
  eq: () => chain,
  limit: async () => ({ data: goals, error: null }),
  update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
};
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({ from: () => chain }),
  tenantRpc: (...a: unknown[]) => rpc(...(a as [])),
}));

import { refreshGoalNumbers } from "../refresh-goal-numbers";
import type { MeasureDeps } from "../goal-metric-resolver";

const deps = (bv: number | null): MeasureDeps => ({
  readNativeStep: async () => null,
  readOperatorFunnelBookings: async () => null,
  readOperatorNewUsers: async () => null,
  readStripeMrr: async () => null,
  readStripeGrossRevenue: async () => 70_000,
  readBookingValue30d: async () => (bv == null ? null : { usd: bv, net_of_refunds: true }),
});

describe("refreshGoalNumbers with a picked money source", () => {
  it("must catch: the picked bookings source is unreadable -> no write, never Stripe's number", async () => {
    rpc.mockClear();
    expect(await refreshGoalNumbers("t-1", new Date("2026-10-11T12:00:00Z"), deps(null))).toEqual({ measured: 0, failed: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("the picked source readable -> its value is written", async () => {
    rpc.mockClear();
    await refreshGoalNumbers("t-1", new Date("2026-10-11T12:00:00Z"), deps(44_806));
    expect(rpc).toHaveBeenCalledWith("t-1", "update_goal_progress", { p_goal_id: "g-1", p_current_value: 44_806 });
  });
});
