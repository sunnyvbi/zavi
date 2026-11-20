import { describe, it, expect } from "vitest";
import { vi } from "vitest";

vi.mock("@/services/settings", () => ({
  getBoolSettingStrictResolved: async () => false,
}));
let agentRunsLimit: () => Promise<{ data: unknown[] | null; error: unknown }>;
const tenantClientCalls: string[] = [];
const eqCalls: Array<[string, unknown]> = [];
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (t: string) => {
    tenantClientCalls.push(t);
    return {
      from: () => ({
        select: () => ({
          eq: (k: string, v: unknown) => {
            eqCalls.push([k, v]);
            return { limit: () => agentRunsLimit() };
          },
        }),
      }),
    };
  },
}));
vi.mock("@/services/growth/auto-first-run", () => ({
  firstRunKey: (t: string) => `first-run:${t}`,
}));

import {
  GROWTH_SCHEDULED_WORKERS,
  defaultSchedulerCapabilityDeps,
  resolveSchedulerCapability,
  type SchedulerCapabilityDeps,
} from "../scheduler-capability";
import { isWorkerCronStopped } from "../cron-stopped";

const T = "11111111-1111-4111-8111-111111111111";

function deps(over: Partial<SchedulerCapabilityDeps> = {}): SchedulerCapabilityDeps {
  return {
    now: () => new Date("2026-10-07T06:30:00.000Z"),
    autopilotEnabled: async () => true,
    firstRunUsed: async () => false,
    workerStopped: isWorkerCronStopped,
    ...over,
  };
}

describe("resolveSchedulerCapability", () => {
  it("reports channel-sweep blocked by the worker allowlist and the CGO clocks allowed", async () => {
    const cap = await resolveSchedulerCapability(T, deps());
    const byName = Object.fromEntries(cap.scheduled_workers.map((w) => [w.worker, w]));

    expect(byName["channel-sweep"]).toMatchObject({
      allowlisted: false,
      blocking_reason: "worker_allowlist",
      cron: "0 7 * * *",
    });
    for (const w of ["goal-reconcile", "cgo-daily-check", "ad-budget-reconcile", "cgo-budget-review", "ad-spend-controller"]) {
      expect(byName[w], w).toMatchObject({ allowlisted: true, blocking_reason: null });
    }
  });

  it("computes the next nominal tick in UTC from each registered cron", async () => {
    const cap = await resolveSchedulerCapability(T, deps());
    const tick = Object.fromEntries(
      cap.scheduled_workers.map((w) => [w.worker, w.next_nominal_tick_at]),
    );
    expect(cap.observed_at).toBe("2026-10-07T06:30:00.000Z");
    expect(tick["channel-sweep"]).toBe("2026-10-07T07:00:00.000Z");
    expect(tick["goal-reconcile"]).toBe("2026-10-07T13:30:00.000Z");
    expect(tick["cgo-daily-check"]).toBe("2026-10-07T14:00:00.000Z");
    expect(tick["ad-budget-reconcile"]).toBe("2026-10-07T07:07:00.000Z");
    expect(tick["cgo-budget-review"]).toBe("2026-10-07T07:23:00.000Z");
    expect(tick["ad-spend-controller"]).toBe("2026-10-07T06:41:00.000Z");
    for (const w of cap.scheduled_workers) expect(w.timezone).toBe("UTC");
  });

  it("a boundary instant is its own next nominal tick", async () => {
    const cap = await resolveSchedulerCapability(
      T,
      deps({ now: () => new Date("2026-10-07T07:00:00.000Z") }),
    );
    const sweep = cap.scheduled_workers.find((w) => w.worker === "channel-sweep");
    expect(sweep?.next_nominal_tick_at).toBe("2026-10-07T07:00:00.000Z");
  });

  it("passes through autopilot and first-run facts, including unknown", async () => {
    const on = await resolveSchedulerCapability(T, deps({ autopilotEnabled: async () => true }));
    expect(on.autopilot_enabled).toBe(true);
    expect(on.event_driven.paid_first_run).toEqual({
      trigger: "cgo_strategy_apply",
      used: false,
      eligibility: "not_evaluated",
      next_nominal_tick_at: null,
    });
    expect(on.event_driven.free_preview).toEqual({
      trigger: "cgo_strategy_apply",
      eligibility: "not_evaluated",
      next_nominal_tick_at: null,
    });

    const unknown = await resolveSchedulerCapability(
      T,
      deps({ autopilotEnabled: async () => false, firstRunUsed: async () => null }),
    );
    expect(unknown.autopilot_enabled).toBe(false);
    expect(unknown.event_driven.paid_first_run.used).toBeNull();
  });

  it("covers every registered worker, versioned", async () => {
    const cap = await resolveSchedulerCapability(T, deps());
    expect(cap.version).toBe(1);
    expect(cap.scheduled_workers.map((w) => w.worker)).toEqual(
      GROWTH_SCHEDULED_WORKERS.map((w) => w.worker),
    );
  });
});

describe("defaultSchedulerCapabilityDeps.firstRunUsed", () => {
  it("true when a run row carries the tenant's first-run dedupe key", async () => {
    tenantClientCalls.length = 0;
    eqCalls.length = 0;
    agentRunsLimit = async () => ({ data: [{ id: "run_1" }], error: null });
    await expect(defaultSchedulerCapabilityDeps.firstRunUsed(T)).resolves.toBe(true);
    expect(tenantClientCalls).toEqual([T]);
    expect(eqCalls).toEqual([["cron_dedupe_key", `first-run:${T}`]]);
  });

  it("false when no row matches", async () => {
    agentRunsLimit = async () => ({ data: [], error: null });
    await expect(defaultSchedulerCapabilityDeps.firstRunUsed(T)).resolves.toBe(false);
  });

  it("null on a returned database error", async () => {
    agentRunsLimit = async () => ({ data: null, error: { message: "db down" } });
    await expect(defaultSchedulerCapabilityDeps.firstRunUsed(T)).resolves.toBeNull();
  });

  it("null on a thrown error", async () => {
    agentRunsLimit = async () => {
      throw new Error("boom");
    };
    await expect(defaultSchedulerCapabilityDeps.firstRunUsed(T)).resolves.toBeNull();
  });
});
