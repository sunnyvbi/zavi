import { describe, it, expect, vi, beforeEach } from "vitest";

let stopped = false;
vi.mock("@/services/agents/cron-stopped", () => ({ isWorkerCronStopped: () => stopped }));
const sent: unknown[] = [];
vi.mock("../../client", () => ({ inngest: { createFunction: vi.fn(() => ({ id: "fn" })), send: async (e: unknown) => sent.push(e) } }));

let overdueRows: Array<{ tenant_id: string }> = [];

const tenantRows = [{ tenant_id: "t1" }, { tenant_id: "t2" }, { tenant_id: "t1" }, { tenant_id: "t3" }];
const excluded = new Set<string>();
const tenantFilters: string[] = [];
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) =>
      table === "tenants"
        ? {
            select: () => {
              let ids: string[] = [];
              const q = {
                in: (_c: string, v: string[]) => ((ids = v), q),
                or: (f: string) => (tenantFilters.push(f), q),
                is: (c: string, v: null) => (tenantFilters.push(`${c} is ${v}`), q),
                then: (ok: (v: unknown) => unknown) =>
                  Promise.resolve({ data: ids.filter((id) => !excluded.has(id)).map((id) => ({ id })), error: null }).then(ok),
              };
              return q;
            },
          }
        : table === "cgo_questions"
          ? { select: () => ({ eq: () => ({ lte: () => ({ limit: async () => ({ data: overdueRows, error: null }) }) }) }) }
          : { select: () => ({ eq: () => ({ limit: async () => ({ data: tenantRows, error: null }) }) }) },
  }),
}));

const autopilot: Record<string, boolean> = {};
let settingsDown = false;
vi.mock("@/services/settings", () => ({
  getBoolSettingStrictResolved: async (_k: string, t: string) => {
    if (settingsDown) throw new Error("settings read failed");
    return autopilot[t] ?? false;
  },
}));

const readWatchState = vi.fn();
const computeAlarms = vi.fn();
vi.mock("@/services/growth/cgo-watch", () => ({
  readWatchState: (...a: unknown[]) => readWatchState(...a),
  computeAlarms: (...a: unknown[]) => computeAlarms(...a),
}));
const recordWakeSkip = vi.fn();
vi.mock("@/services/growth/cgo-wake-skips", () => ({ recordWakeSkip: (...a: unknown[]) => recordWakeSkip(...a) }));
const enqueueGoalOwnerRun = vi.fn();
vi.mock("@/services/growth/goal-owner", () => ({
  enqueueGoalOwnerRun: (...a: unknown[]) => enqueueGoalOwnerRun(...a),
}));
const sweepExpiredQuestions = vi.fn();
vi.mock("@/services/growth/cgo-questions", () => ({ sweepExpiredQuestions: (...a: unknown[]) => sweepExpiredQuestions(...a) }));
const idle = new Set<string>();
vi.mock("@/services/growth/tenant-idle", () => ({ tenantIsIdle: async (t: string) => idle.has(t) }));
const notesWritten: Array<Record<string, unknown>> = [];
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      let row: Record<string, unknown> | null = null;
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: () => q,
        insert: (r: Record<string, unknown>) => ((row = r), notesWritten.push(r), q),
        maybeSingle: async () => (row ? { data: { id: "note-1" }, error: null } : { data: { next_review_at: "2026-10-05T00:00:00.000Z" }, error: null }),
      });
      return q;
    },
  }),
}));

import { runDailyCheck } from "../cgo-daily-check";

beforeEach(() => {
  overdueRows = [];
  sent.length = 0;
  notesWritten.length = 0;
  sweepExpiredQuestions.mockReset().mockResolvedValue({ expired: 0, applied: [] });
  stopped = false;
  settingsDown = false;
  for (const k of Object.keys(autopilot)) delete autopilot[k];
  readWatchState.mockReset().mockResolvedValue({ goals: [{ id: "g" }] });
  computeAlarms.mockReset().mockReturnValue({ wake: true, kind: "scheduled", reasons: ["review_due"], keys: [] });
  enqueueGoalOwnerRun.mockReset().mockResolvedValue({ enqueued: true, run_id: "r" });
  recordWakeSkip.mockReset();
  idle.clear();
});

describe("runDailyCheck", () => {
  it("skips test, deleted and disabled tenants: no review, no credits, no founder email", async () => {
    excluded.clear();
    excluded.add("t2");
    tenantFilters.length = 0;
    computeAlarms.mockReturnValue({ wake: false });
    readWatchState.mockResolvedValue({ goals: [{}] });
    const out = await runDailyCheck();
    expect(out).toMatchObject({ tenants: 2 });
    expect(readWatchState.mock.calls.map((c) => c[0])).toEqual(["t1", "t3"]);
    expect(tenantFilters).toEqual(["kind.is.null,kind.neq.test", "deleted_at is null", "disabled_at is null"]);
    excluded.clear();
  });

  it("a left-out tenant with Autopilot on gets a wake-skip row saying why; one with it off gets none", async () => {
    excluded.clear();
    excluded.add("t2");
    excluded.add("t3");
    autopilot.t2 = true;
    computeAlarms.mockReturnValue({ wake: false });
    readWatchState.mockResolvedValue({ goals: [{}] });
    const out = await runDailyCheck();
    expect(out).toMatchObject({ tenants: 1, left_out_with_autopilot: 1 });
    expect(recordWakeSkip).toHaveBeenCalledWith("t2", "daily_check", "not_live_tenant");
    expect(recordWakeSkip).not.toHaveBeenCalledWith("t3", "daily_check", "not_live_tenant");
    excluded.clear();
  });

  it("a tenant nobody used for 7 days gets no check-in and no founder note, silently", async () => {
    idle.add("t2");
    const out = await runDailyCheck();
    expect(readWatchState.mock.calls.map((c) => c[0])).toEqual(["t1", "t3"]);
    expect(enqueueGoalOwnerRun.mock.calls.map((c) => (c[0] as { tenant_id: string }).tenant_id)).toEqual(["t1", "t3"]);
    expect(out).toMatchObject({ tenants: 3, woke: 2, skipped: 1, errors: 0 });
    expect(recordWakeSkip).toHaveBeenCalledWith("t2", "daily_check", "idle_7d");
    expect(notesWritten).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("resumes on the next check once the tenant is active again (nothing stored)", async () => {
    idle.add("t2");
    await runDailyCheck();
    idle.clear();
    enqueueGoalOwnerRun.mockClear();
    await runDailyCheck();
    expect(enqueueGoalOwnerRun.mock.calls.map((c) => (c[0] as { tenant_id: string }).tenant_id)).toEqual(["t1", "t2", "t3"]);
  });

  it("does nothing when the clock is stopped", async () => {
    stopped = true;
    expect(await runDailyCheck()).toEqual({ cron_stopped: true });
    expect(readWatchState).not.toHaveBeenCalled();
  });

  it("checks each tenant once; an empty wallet or an error on one tenant does not stop the rest", async () => {
    enqueueGoalOwnerRun
      .mockRejectedValueOnce(Object.assign(new Error('Agent "cgo" rejected: out of credits — top up to keep running'), { name: "InsufficientCreditsError" }))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ enqueued: true, run_id: "r3" });
    const out = await runDailyCheck();
    expect(readWatchState).toHaveBeenCalledTimes(3);
    expect(out).toMatchObject({ tenants: 3, woke: 1, errors: 1, skipped: 1 });
    expect(recordWakeSkip).toHaveBeenCalledWith("t2", "daily_check", "error");
  });

  it("passes the tenant's autopilot flag to the alarm decision and the alarms to the review", async () => {
    autopilot.t2 = true;
    await runDailyCheck();
    expect(computeAlarms.mock.calls.map((c) => c[2])).toEqual([{ autopilot: false }, { autopilot: true }, { autopilot: false }]);
    expect(enqueueGoalOwnerRun).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: "t1", reason: "daily_check", check: { kind: "scheduled", reasons: ["review_due"], alarm_keys: [] } }),
    );
  });

  it("a failed settings read is an error for that tenant, never a silent advice run", async () => {
    settingsDown = true;
    const out = await runDailyCheck();
    expect(enqueueGoalOwnerRun).not.toHaveBeenCalled();
    expect(out).toMatchObject({ tenants: 3, errors: 3, woke: 0 });
  });

  it("a quiet tenant is not enqueued", async () => {
    computeAlarms.mockReturnValue({ wake: false, kind: "alarm", reasons: [], keys: [] });
    const out = await runDailyCheck();
    expect(enqueueGoalOwnerRun).not.toHaveBeenCalled();
    expect(out).toMatchObject({ woke: 0 });
    expect(recordWakeSkip).toHaveBeenCalledWith(expect.any(String), "daily_check", "nothing_due");
  });
});

describe("overdue questions (no model, no credits)", () => {
  it("are swept for every live tenant, goals or not, before today's alarms; Autopilot is passed through", async () => {
    excluded.clear();
    overdueRows = [{ tenant_id: "t9" }, { tenant_id: "t9" }];
    autopilot.t9 = true;
    const order: string[] = [];
    sweepExpiredQuestions.mockImplementation(async (t: string, _now: Date, deps: { autopilot: boolean }) => {
      order.push(`sweep:${t}:${deps.autopilot}`);
      return { expired: 1, applied: [] };
    });
    readWatchState.mockImplementation(async (t: string) => (order.push(`check:${t}`), { goals: [{}] }));
    computeAlarms.mockReturnValue({ wake: false });
    await runDailyCheck(new Date("2026-09-27T14:00:00Z"));
    expect(order[0]).toBe("sweep:t9:true");
    expect(order.filter((o) => o.startsWith("sweep"))).toHaveLength(1);
    expect(notesWritten).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("an applied default is told to the founder in a note of its own that keeps the check-in date", async () => {
    excluded.clear();
    overdueRows = [{ tenant_id: "t9" }];
    autopilot.t9 = true;
    sweepExpiredQuestions.mockResolvedValue({ expired: 1, applied: ['No answer on "Keep Reddit?", so I paused Reddit as I said I would.'] });
    computeAlarms.mockReturnValue({ wake: false });
    await runDailyCheck(new Date("2026-09-27T14:00:00Z"));
    expect(notesWritten).toEqual([
      expect.objectContaining({ tenant_id: "t9", run_id: null, kind: "alarm", changed: ['No answer on "Keep Reddit?", so I paused Reddit as I said I would.'], next_review_at: "2026-10-05T00:00:00.000Z" }),
    ]);
    expect(sent).toEqual([{ id: "cgo-note-email:note:note-1", name: "cgo/note.email", data: { note_id: "note-1", tenant_id: "t9" } }]);
  });

  it("one tenant's sweep failing does not stop the daily check", async () => {
    excluded.clear();
    overdueRows = [{ tenant_id: "t9" }];
    sweepExpiredQuestions.mockRejectedValue(new Error("boom"));
    const r = await runDailyCheck(new Date("2026-09-27T14:00:00Z"));
    expect(r).toMatchObject({ tenants: 3 });
  });
});
