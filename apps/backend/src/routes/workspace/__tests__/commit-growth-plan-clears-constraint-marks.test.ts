import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  clearPause: vi.fn(async () => {}),
  clearMarks: vi.fn(async () => {}),
}));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ rpc: mocks.rpc }), serverClientFromBearer: vi.fn() }));
vi.mock("@/services/growth/goal-owner", async (orig) => ({ ...(await orig<object>()), clearCgoPauseReasons: mocks.clearPause }));
vi.mock("@/services/growth/cgo-hypotheses", async (orig) => ({ ...(await orig<object>()), clearPlanConstraintMarks: mocks.clearMarks }));

import { commitGrowthPlanServiceRole } from "../autopilot";

const input = {
  tenant_id: "tenant-a",
  objective: "Grow signups",
  north_star_metric: "signups",
  constraint_statement: "Too few visitors",
  constraint_confidence: "medium",
  bets: [],
};

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.clearMarks.mockClear();
});

describe("commitGrowthPlanServiceRole", () => {
  it("clears the tenant's plan-constraint marks once the plan commits", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: "plan-1", error: null });
    expect(await commitGrowthPlanServiceRole(input)).toEqual({ ok: true, plan_id: "plan-1" });
    expect(mocks.clearMarks).toHaveBeenCalledWith("tenant-a");
  });

  it("a plan that did not commit clears nothing", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    expect(await commitGrowthPlanServiceRole(input)).toMatchObject({ ok: false });
    expect(mocks.clearMarks).not.toHaveBeenCalled();
  });
});
