import { describe, it, expect, vi, beforeEach } from "vitest";

let stopped = false;
vi.mock("@/services/agents/cron-stopped", () => ({ isWorkerCronStopped: (n: string) => (n === "cgo-budget-review" ? stopped : true) }));
vi.mock("../../client", () => ({ inngest: { createFunction: vi.fn(() => ({ id: "fn" })) } }));

let budgetRows: Array<{ tenant_id: string }> = [];
const budgetFilters: string[] = [];
const testTenants = new Set<string>();
const tenantReads = vi.fn();
const from = (table: string) => {
  if (table === "ad_budgets") {
    const q = {
      select: () => q,
      eq: (c: string, v: string) => (budgetFilters.push(`${c}=${v}`), q),
      gte: (c: string, v: string) => (budgetFilters.push(`${c}>=${v}`), q),
      limit: async () => ({ data: budgetRows, error: null }),
    };
    return q;
  }
  if (table === "tenants") {
    tenantReads();
    let ids: string[] = [];
    const q = {
      select: () => q,
      in: (_c: string, v: string[]) => ((ids = v), q),
      or: () => q,
      is: () => q,
      then: (ok: (v: unknown) => unknown) =>
        Promise.resolve({ data: ids.filter((id) => !testTenants.has(id)).map((id) => ({ id })), error: null }).then(ok),
    };
    return q;
  }
  throw new Error(`unexpected table ${table}`);
};
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from }) }));
vi.mock("@/services/tenant-client", () => ({ fleetSweepClient: () => ({ from }) }));

const runsAds = new Set<string>();
const cgoAdBudget = vi.fn(async (t: string) => (runsAds.has(t) ? { id: "b" } : null));
vi.mock("@/services/growth/cgo-ads", () => ({ cgoAdBudget: (t: string) => cgoAdBudget(t) }));
const recordWakeSkip = vi.fn();
vi.mock("@/services/growth/cgo-wake-skips", () => ({ recordWakeSkip: (...a: unknown[]) => recordWakeSkip(...a) }));
const enqueueGoalOwnerRun = vi.fn();
vi.mock("@/services/growth/goal-owner", () => ({
  OWN_GOALS_STAGE: "own_goals",
  enqueueGoalOwnerRun: (...a: unknown[]) => enqueueGoalOwnerRun(...a),
}));

let currentSig: () => Promise<string> = async () => "sig-now";
let lastReview: () => Promise<{ status: string; signature: string | null } | null> = async () => null;
const lastReviewStage = vi.fn();
vi.mock("@/services/growth/budget-review-signature", async (orig) => {
  const real = await orig<typeof import("@/services/growth/budget-review-signature")>();
  return {
    nothingChangedSince: real.nothingChangedSince,
    currentBudgetSignature: () => currentSig(),
    readLastReview: (_t: string, stage: string) => (lastReviewStage(stage), lastReview()),
  };
});

let tenantTz = "UTC";
vi.mock("@/services/analytics/tenant-timezone", () => ({ resolveReportingTimezone: async () => ({ tz: tenantTz, source: "stored" }) }));

const settingsRead = vi.fn();
vi.mock("@/services/settings", () => new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : (...a: unknown[]) => settingsRead(k, ...a)) }));

import { runBudgetReview, isBudgetWakeHour, localHour } from "../cgo-budget-review";

const NOW = new Date("2026-09-26T14:23:00Z");

beforeEach(() => {
  stopped = false;
  tenantTz = "UTC";
  budgetRows = [];
  budgetFilters.length = 0;
  testTenants.clear();
  runsAds.clear();
  tenantReads.mockReset();
  cgoAdBudget.mockClear();
  enqueueGoalOwnerRun.mockReset().mockResolvedValue({ enqueued: true, run_id: "r" });
  recordWakeSkip.mockReset();
  currentSig = async () => "sig-now";
  lastReview = async () => null;
  lastReviewStage.mockReset();
});

describe("runBudgetReview", () => {
  it("is cgo's only scheduled wake and has no switch: it runs without reading any setting", async () => {
    budgetRows = [{ tenant_id: "ads" }];
    runsAds.add("ads");
    expect(await runBudgetReview(NOW)).toEqual({ tenants: 1, woke: 1, skipped: 0, errors: 0 });
    expect(settingsRead).not.toHaveBeenCalled();
  });

  it("wakes only tenants with an active budget AND Autopilot on, with the budget-review reason", async () => {
    budgetRows = [{ tenant_id: "ads" }, { tenant_id: "autopilot-off" }];
    runsAds.add("ads");
    const out = await runBudgetReview(NOW);
    expect(out).toEqual({ tenants: 2, woke: 1, skipped: 1, errors: 0 });
    expect(enqueueGoalOwnerRun).toHaveBeenCalledTimes(1);
    expect(enqueueGoalOwnerRun).toHaveBeenCalledWith({ tenant_id: "ads", reason: "ad_budget_review", now: NOW });
    expect(recordWakeSkip).toHaveBeenCalledWith("autopilot-off", "ad_budget_review", "not_running_ads");
    expect(recordWakeSkip).toHaveBeenCalledTimes(1);
    expect(budgetFilters).toEqual(["status=active"]);
  });

  it("skips test tenants before any per-tenant read", async () => {
    budgetRows = [{ tenant_id: "ads" }, { tenant_id: "test-t" }];
    runsAds.add("ads");
    runsAds.add("test-t");
    testTenants.add("test-t");
    const out = await runBudgetReview(NOW);
    expect(out.tenants).toBe(1);
    expect(cgoAdBudget.mock.calls.map((c) => c[0])).toEqual(["ads"]);
    expect(enqueueGoalOwnerRun.mock.calls.map((c) => (c[0] as { tenant_id: string }).tenant_id)).toEqual(["ads"]);
  });

  it("with no active budget: one read, no per-tenant work, nothing sent", async () => {
    const out = await runBudgetReview(NOW);
    expect(out).toEqual({ tenants: 0, woke: 0, skipped: 0, errors: 0 });
    expect(tenantReads).not.toHaveBeenCalled();
    expect(cgoAdBudget).not.toHaveBeenCalled();
    expect(enqueueGoalOwnerRun).not.toHaveBeenCalled();
  });

  it("does nothing when the clock is stopped", async () => {
    stopped = true;
    budgetRows = [{ tenant_id: "ads" }];
    runsAds.add("ads");
    expect(await runBudgetReview(NOW)).toEqual({ cron_stopped: true });
    expect(budgetFilters).toEqual([]);
    expect(enqueueGoalOwnerRun).not.toHaveBeenCalled();
  });

  it("one tenant out of credits or failing never stops the others", async () => {
    budgetRows = [{ tenant_id: "a" }, { tenant_id: "b" }, { tenant_id: "c" }];
    for (const t of ["a", "b", "c"]) runsAds.add(t);
    enqueueGoalOwnerRun
      .mockRejectedValueOnce(Object.assign(new Error("out of credits"), { name: "InsufficientCreditsError" }))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ enqueued: false, skipped: "daily_cap" });
    const out = await runBudgetReview(NOW);
    expect(out).toEqual({ tenants: 3, woke: 0, skipped: 2, errors: 1 });
    expect(recordWakeSkip).toHaveBeenCalledWith("b", "ad_budget_review", "error");
  });

  it("wakes only at a wake hour in the tenant's own time zone", async () => {
    budgetRows = [{ tenant_id: "ads" }];
    runsAds.add("ads");
    tenantTz = "America/Los_Angeles";
    const out = await runBudgetReview(NOW);
    expect(out).toEqual({ tenants: 1, woke: 0, skipped: 1, errors: 0 });
    expect(enqueueGoalOwnerRun).not.toHaveBeenCalled();
    const later = new Date("2026-09-26T17:23:00Z");
    expect((await runBudgetReview(later)).woke).toBe(1);
  });
});

describe("skip when nothing changed (signature rule)", () => {
  beforeEach(() => {
    budgetRows = [{ tenant_id: "ads" }];
    runsAds.add("ads");
  });

  it("skips, records nothing_changed and starts no run when cgo's latest review finished on the same facts", async () => {
    lastReview = async () => ({ status: "success", signature: "sig-now" });
    expect(await runBudgetReview(NOW)).toEqual({ tenants: 1, woke: 0, skipped: 1, errors: 0 });
    expect(enqueueGoalOwnerRun).not.toHaveBeenCalled();
    expect(recordWakeSkip).toHaveBeenCalledWith("ads", "ad_budget_review", "nothing_changed");
    expect(lastReviewStage).toHaveBeenCalledWith("own_goals");
  });

  it("runs when anything moved since the latest review", async () => {
    lastReview = async () => ({ status: "success", signature: "sig-before" });
    expect((await runBudgetReview(NOW)).woke).toBe(1);
    expect(recordWakeSkip).not.toHaveBeenCalled();
  });

  it.each([
    ["the latest review failed", { status: "failed", signature: "sig-now" }],
    ["the latest review is still queued", { status: "queued", signature: "sig-now" }],
    ["the latest review had no signature", { status: "success", signature: null }],
    ["cgo never reviewed", null],
  ])("runs when %s", async (_why, last) => {
    lastReview = async () => last;
    expect((await runBudgetReview(NOW)).woke).toBe(1);
  });

  it("runs (fails open) when a fact or the last review cannot be read", async () => {
    currentSig = async () => {
      throw new Error("facts down");
    };
    lastReview = async () => ({ status: "success", signature: "sig-now" });
    expect((await runBudgetReview(NOW)).woke).toBe(1);
    currentSig = async () => "sig-now";
    lastReview = async () => {
      throw new Error("runs down");
    };
    expect((await runBudgetReview(NOW)).woke).toBe(1);
    expect(enqueueGoalOwnerRun).toHaveBeenCalledTimes(2);
  });

  it("never reads the signature outside a wake hour or without a running budget", async () => {
    tenantTz = "America/Los_Angeles";
    await runBudgetReview(NOW);
    tenantTz = "UTC";
    runsAds.clear();
    await runBudgetReview(NOW);
    expect(lastReviewStage).not.toHaveBeenCalled();
  });
});

describe("budget wake hours", () => {
  it("every 4 hours from 10am to 10pm local, never overnight or at 6am", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 8, 26, h, 23));
    const woke = Array.from({ length: 24 }, (_, h) => h).filter((h) => isBudgetWakeHour(at(h), "UTC"));
    expect(woke).toEqual([10, 14, 18, 22]);
  });

  it("reads the hour in the tenant's zone, including half-hour offsets", () => {
    expect(localHour(new Date("2026-09-26T00:30:00Z"), "Asia/Kolkata")).toBe(6);
    expect(localHour(new Date("2026-09-26T13:00:00Z"), "America/Los_Angeles")).toBe(6);
  });

  it("an unknown zone reads as UTC", () => {
    expect(localHour(new Date("2026-09-26T10:00:00Z"), "Not/AZone")).toBe(10);
  });
});
