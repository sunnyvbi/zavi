import { describe, it, expect, vi, beforeEach } from "vitest";

let stopped = false;
vi.mock("@/services/agents/cron-stopped", () => ({ isWorkerCronStopped: (n: string) => (n === "ad-spend-controller" ? stopped : true) }));
let canonical = true;
vi.mock("@/services/agents/boot-role", () => ({ isCanonicalContainer: () => canonical }));
type Handler = (ctx: { step: { run: (n: string, fn: () => unknown) => unknown } }) => unknown;
const fnReg = vi.hoisted(() => ({ handler: null as Handler | null, calls: [] as unknown[][] }));
vi.mock("../../client", () => ({
  inngest: {
    createFunction: (cfg: unknown, trigger: unknown, fn: Handler) => {
      fnReg.calls.push([cfg, trigger]);
      fnReg.handler = fn;
      return { id: "fn" };
    },
  },
}));

const tenantsWithActiveBudgets = vi.fn();
vi.mock("../cgo-budget-review", () => ({ tenantsWithActiveBudgets: () => tenantsWithActiveBudgets() }));
const runSpendControllerForTenant = vi.fn();
vi.mock("@/services/growth/ad-spend-controller", () => ({ runSpendControllerForTenant: (...a: unknown[]) => runSpendControllerForTenant(...a) }));

const sweepStuckAdChanges = vi.fn();
vi.mock("@/services/growth/stuck-ad-changes", () => ({ sweepStuckAdChanges: (...a: unknown[]) => sweepStuckAdChanges(...a) }));
const flushAllPendingCgoNotes = vi.fn();
vi.mock("@/services/growth/cgo-note-notifications", () => ({ flushAllPendingCgoNotes: () => flushAllPendingCgoNotes() }));

const testStopTenants = vi.fn();
const monitorTestStops = vi.fn();
vi.mock("@/services/growth/test-stops", () => ({ tenantsWithTestStops: () => testStopTenants(), monitorTestStops: (...a: unknown[]) => monitorTestStops(...a) }));
vi.mock("../_job-errors", () => ({ logJobError: vi.fn(async () => undefined) }));
const alertMoney = vi.fn(async () => undefined);
vi.mock("../_money-job-alert", () => ({ alertMoneyJobErrors: (...a: unknown[]) => alertMoney(...(a as [])) }));

import { runAdSpendControllerTick } from "../ad-spend-controller";

const NOW = new Date("2026-10-02T15:41:00Z");

beforeEach(() => {
  stopped = false;
  canonical = true;
  tenantsWithActiveBudgets.mockReset().mockResolvedValue(["t1", "t2"]);
  testStopTenants.mockReset().mockResolvedValue([]);
  monitorTestStops.mockReset().mockResolvedValue({ checked: 0, pausing: 0 });
  alertMoney.mockClear();
  sweepStuckAdChanges.mockReset().mockResolvedValue({ stuck: 0, alerted: 0, failed: 0 });
  flushAllPendingCgoNotes.mockReset().mockResolvedValue({ tenants: 0, queued: 0, failed: 0 });
  runSpendControllerForTenant.mockReset().mockImplementation(async (t: string) =>
    t === "t1" ? { tenant_id: t, outcome: "ran" } : { tenant_id: t, outcome: "skipped", why: "not_running_ads" },
  );
});

describe("held-question tidy after each tenant (cgo-log 2026-10-23)", () => {
  it("runs only after a full pass: a skipped or failed tenant keeps its hold lines and questions", async () => {
    tenantsWithActiveBudgets.mockResolvedValue(["t1", "t2", "t3"]);
    runSpendControllerForTenant.mockImplementation(async (t: string) =>
      t === "t1" ? { tenant_id: t, outcome: "ran" } : t === "t2" ? { tenant_id: t, outcome: "skipped", why: "no_pace" } : { tenant_id: t, outcome: "error", error: "x" },
    );
    const afterTenant = vi.fn(async () => undefined);
    await runAdSpendControllerTick(NOW, { afterTenant });
    expect(afterTenant.mock.calls).toEqual([["t1", NOW]]);
  });
});

describe("test stops in the hourly tick (test-stops.ts)", () => {
  it("checks every tenant with an open stop, Autopilot or not, before the controller, and a failed tenant never stops the hour", async () => {
    tenantsWithActiveBudgets.mockResolvedValue([]);
    testStopTenants.mockResolvedValue(["s1", "s2"]);
    monitorTestStops.mockImplementation(async (t: string) => {
      if (t === "s1") throw new Error("read failed");
      return { checked: 1, pausing: 1 };
    });
    const r = await runAdSpendControllerTick(NOW);
    expect(monitorTestStops.mock.calls.map((c) => c[0])).toEqual(["s1", "s2"]);
    expect(r).toMatchObject({ test_stops: { tenants: 2, errors: 1 }, tenants: 0 });
    expect(alertMoney).toHaveBeenCalledWith("ad-spend-controller:test-stops", ["s1"], 2);
  });
  it("cron stopped: no test stop is read either", async () => {
    stopped = true;
    await runAdSpendControllerTick(NOW);
    expect(testStopTenants).not.toHaveBeenCalled();
  });
});

describe("ad-spend-controller worker", () => {
  it("cron stopped: no budget read, no tenant worked, nothing written", async () => {
    stopped = true;
    expect(await runAdSpendControllerTick(NOW)).toEqual({ cron_stopped: true });
    expect(tenantsWithActiveBudgets).not.toHaveBeenCalled();
    expect(runSpendControllerForTenant).not.toHaveBeenCalled();
    expect(sweepStuckAdChanges).not.toHaveBeenCalled();
    expect(flushAllPendingCgoNotes).not.toHaveBeenCalled();
  });

  it("works every tenant with an active budget, once each", async () => {
    expect(await runAdSpendControllerTick(NOW)).toEqual({ stuck: { stuck: 0, alerted: 0, failed: 0 }, pending_notes: { tenants: 0, queued: 0, failed: 0 }, test_stops: { tenants: 0, errors: 0 }, tenants: 2, ran: 1, skipped: 1, errors: 0 });
    expect(runSpendControllerForTenant.mock.calls.map((c) => c[0])).toEqual(["t1", "t2"]);
  });

  it("no active budget: no tenant worked, but stuck ad changes are still swept", async () => {
    tenantsWithActiveBudgets.mockResolvedValue([]);
    expect(await runAdSpendControllerTick(NOW)).toEqual({ stuck: { stuck: 0, alerted: 0, failed: 0 }, pending_notes: { tenants: 0, queued: 0, failed: 0 }, test_stops: { tenants: 0, errors: 0 }, tenants: 0, ran: 0, skipped: 0, errors: 0 });
    expect(runSpendControllerForTenant).not.toHaveBeenCalled();
    expect(sweepStuckAdChanges).toHaveBeenCalledWith(NOW);
    expect(flushAllPendingCgoNotes).toHaveBeenCalledTimes(1);
  });

  it("a failed stuck sweep never fails the hour", async () => {
    sweepStuckAdChanges.mockRejectedValue(new Error("db down"));
    flushAllPendingCgoNotes.mockRejectedValue(new Error("db down"));
    expect(await runAdSpendControllerTick(NOW)).toMatchObject({ stuck: null, pending_notes: null, tenants: 2, ran: 1 });
  });

  it("hourly after the reconcile, and never from a non-prod container", async () => {
    expect(fnReg.calls).toEqual([[expect.objectContaining({ id: "ad-spend-controller" }), { cron: "41 * * * *" }]]);
    canonical = false;
    const run = vi.fn();
    expect(await fnReg.handler!({ step: { run } })).toEqual({ skipped: "not_canonical" });
    expect(run).not.toHaveBeenCalled();
  });
});
