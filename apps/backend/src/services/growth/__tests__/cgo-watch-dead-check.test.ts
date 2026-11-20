
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ checks: [] as Array<{ enqueued_at: string; status: string }> }));

vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig),
);
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      let dailyCheck = false;
      const notStatus: string[] = [];
      const self: Record<string, unknown> = {};
      for (const m of ["select", "gte", "order", "limit", "not", "or", "in"]) self[m] = () => self;
      self.eq = (k: string, v: unknown) => {
        if (table === "agent_runs" && k === "payload->>reason" && v === "daily_check") dailyCheck = true;
        return self;
      };
      self.neq = (k: string, v: unknown) => {
        if (k === "status") notStatus.push(String(v));
        return self;
      };
      self.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: table === "agent_runs" && dailyCheck ? h.checks.filter((c) => !notStatus.includes(c.status)).slice(0, 1) : [],
          error: null,
          count: 0,
        }).then(resolve);
      return self;
    },
  }),
}));
vi.mock("../channel-autorun", async (orig) => ({
  ...(await orig<typeof import("../channel-autorun")>()),
  readAutopilotState: vi.fn(async () => null),
}));

import { computeAlarms, readWatchState } from "../cgo-watch";
import { resetTenantPlan } from "@/__tests__/helpers/tenant-plan";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const NOW = new Date("2026-10-24T14:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

beforeEach(() => {
  resetTenantPlan();
  h.checks = [];
});

describe("readWatchState: a check that broke and was refunded does not hold the next one", () => {
  it("must-catch: a first review refused by the seat 3 days ago (dispatch_error) does not silence the tenant", async () => {
    h.checks = [{ enqueued_at: daysAgo(3), status: "dispatch_error" }];
    const s = await readWatchState(T, NOW);
    expect(s.last_check_run_at).toBeNull();
    expect(computeAlarms(s, NOW).wake).toBe(true);
  });

  it("must-not-touch: a check that ran and failed (parse_failed) 3 days ago still holds the week, as designed", async () => {
    h.checks = [{ enqueued_at: daysAgo(3), status: "parse_failed" }];
    const s = await readWatchState(T, NOW);
    expect(s.last_check_run_at).toBe(daysAgo(3));
    expect(computeAlarms(s, NOW).wake).toBe(false);
  });
});
