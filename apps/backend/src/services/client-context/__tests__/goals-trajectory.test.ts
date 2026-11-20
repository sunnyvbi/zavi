import { describe, expect, it, vi } from "vitest";
import { loadGoals } from "../sections";

let rows: Array<Record<string, unknown>> = [];
vi.mock("@/services/tenant-client", () => {
  const q: Record<string, unknown> = {};
  for (const k of ["select", "eq", "order"]) q[k] = () => q;
  q.limit = async () => ({ data: rows, error: null });
  return {
    staffCrossTenantClient: () => ({ from: () => q }),
    asTenantId: (t: string) => t,
    tenantClient: () => ({ from: () => q }),
  };
});

const base = {
  id: "g1",
  objective: "GMV push",
  target_metric: "gmv",
  target_value: 300000,
  baseline_value: 157000,
  current_value: 70000,
  current_value_at: "2026-10-11T03:20:53Z",
  due_date: "2026-10-31",
  status: "active",
  priority: 50,
  created_at: "2026-10-01T18:55:50Z",
  updated_at: "2026-10-11T03:20:53Z",
  measurement_mode: "manual_reported",
  count_rule: null,
  value_kind: null,
  value_period_start: null,
};
const NOW = new Date("2026-10-12T12:00:00Z");

describe("loadGoals", () => {
  it("a typed number that could be either reading: no progress, behind on both lines, and says why", async () => {
    rows = [base];
    const s = await loadGoals("t1", NOW);
    expect(s.data.goals[0].progress).toBeNull();
    expect(s.data.summary.needs_attention).toBe(1);
    expect(s.detail).toMatch(/no stated way of counting/);
    expect(s.detail).not.toMatch(/no baseline or current value/);
  });
  it("a period total paces from 0 on its start day, judged on the day the number describes", async () => {
    rows = [{ ...base, value_kind: "period_total", value_period_start: "2026-10-01", current_value: 110000 }];
    const s = await loadGoals("t1", NOW);
    expect(s.data.goals[0].progress).toBeCloseTo(110000 / 300000);
    expect(s.data.summary.on_track).toBe(1);
  });
  it("a number too old to pace on is not judged on track or behind", async () => {
    rows = [{ ...base, value_kind: "period_total", value_period_start: "2026-10-01", current_value_at: "2026-10-02T00:00:00Z", current_value: 500 }];
    const s = await loadGoals("t1", NOW);
    expect(s.data.summary).toMatchObject({ on_track: 0, needs_attention: 0 });
  });
});
