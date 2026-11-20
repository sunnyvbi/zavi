import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  resolved: { tz: "UTC", source: "default" } as { tz: string; source: string } | Error,
}));

vi.mock("@/services/analytics/tenant-timezone", () => ({
  resolveReportingTimezone: vi.fn(async () => {
    if (h.resolved instanceof Error) throw h.resolved;
    return h.resolved;
  }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(async () => {
    throw new Error("unexpected live rpc");
  }),
  staffCrossTenantClient: () => {
    throw new Error("unexpected cross-tenant read");
  },
  tenantClient: () => ({
    from: () => ({ select: () => ({ maybeSingle: async () => ({ data: { timezone: null }, error: null }) }) }),
  }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => undefined) } }));

import { livePlanPassDeps } from "../live";
import { runEmailPlanPass, type PassDeps, type ScheduleRow } from "../pass";

const T = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-27T03:00:00Z");
const LA: ScheduleRow = { tenant_id: T, lease_token: "", timezone: "America/Los_Angeles" };

async function pass(over: Partial<PassDeps>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const live = await livePlanPassDeps();
  const deps: PassDeps = {
    ...live,
    now: () => NOW,
    repair: async () => 0,
    alertStuckHolds: async () => 0,
    outboxPending: async () => [],
    claimJobs: async () => [],
    schedulesMissing: async () => [],
    claimSchedules: async () => [],
    claimZoneChecks: async () => [],
    weeklyEligible: async () => false,
    startRun: vi.fn(async () => ({ ok: true })),
    rpc: (async (_t: string, name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return 1;
    }) as PassDeps["rpc"],
    ...over,
  };
  const report = await runEmailPlanPass(deps);
  return { calls, report };
}

const tzWrites = (calls: Array<{ name: string; args: Record<string, unknown> }>) =>
  calls.filter((c) => c.name === "set_email_plan_schedule" || c.name === "finish_email_plan_schedule").map((c) => c.args.p_tz);

describe("the hourly zone check against a failed time-zone lookup", () => {
  beforeEach(() => {
    h.resolved = { tz: "UTC", source: "default" };
  });

  it("a default UTC answer is an absence: the LA schedule is not rezoned to UTC", async () => {
    const { calls, report } = await pass({ claimZoneChecks: async () => [LA] });
    expect(calls.filter((c) => c.name === "set_email_plan_schedule")).toEqual([]);
    expect(tzWrites(calls)).not.toContain("UTC");
    expect(report.rezoned).toBe(0);
  });

  it("the Monday run on a default UTC answer plans the LA week and keeps the schedule in LA", async () => {
    const start = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
    const { calls } = await pass({
      claimSchedules: async () => [{ ...LA, lease_token: "L" }],
      weeklyEligible: async () => true,
      startRun: start,
    });
    expect(tzWrites(calls)).toEqual(["America/Los_Angeles"]);
    expect(start.mock.calls[0]?.[1]).toMatchObject({ email_plan: { timezone: "America/Los_Angeles", week_of: "2026-10-26" } });
  });

  it("a lookup that throws leaves the LA schedule alone and counts an error", async () => {
    h.resolved = new Error("settings down");
    const { calls, report } = await pass({ claimZoneChecks: async () => [LA] });
    expect(tzWrites(calls)).toEqual([]);
    expect(report.errors).toBe(1);
  });

  it("a real zone change (Chicago, set by the founder) still moves the schedule to Chicago", async () => {
    h.resolved = { tz: "America/Chicago", source: "stored" };
    const { calls, report } = await pass({ claimZoneChecks: async () => [LA] });
    expect(calls.filter((c) => c.name === "set_email_plan_schedule").map((c) => c.args.p_tz)).toEqual(["America/Chicago"]);
    expect(report.rezoned).toBe(1);
  });

  it("a brand-new workspace with no zone yet still gets a UTC Monday", async () => {
    const { calls, report } = await pass({ schedulesMissing: async () => [T] });
    expect(calls.filter((c) => c.name === "set_email_plan_schedule").map((c) => c.args.p_tz)).toEqual(["UTC"]);
    expect(report.scheduled).toBe(1);
  });
});
