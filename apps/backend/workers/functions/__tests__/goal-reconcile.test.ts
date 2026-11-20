
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const state: {
    rpcImpl: (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>;
    tenantRows: Array<{ id: string }>;
    goalRowsByTenant: Record<string, unknown[]>;
    goalsReadError: { message: string } | null;
    fromCalls: string[];
    updateGoalCalls: Array<{ p_tenant_id: string; p_goal_id: string; p_current_value: number }>;
    enabledByTenant: Record<string, boolean>;
    throwOnSettingTenant: string | null;
    throwOnGoalReadTenant: string | null;
    enqueueCalls: Array<Record<string, unknown>>;
    stamps: Array<{ patch: Record<string, unknown>; filters: Record<string, unknown> }>;
  } = {
    rpcImpl: async () => ({ data: null, error: null }),
    tenantRows: [],
    goalRowsByTenant: {},
    goalsReadError: null,
    fromCalls: [],
    updateGoalCalls: [],
    enabledByTenant: {},
    throwOnSettingTenant: null,
    throwOnGoalReadTenant: null,
    enqueueCalls: [],
    stamps: [],
  };

  const serviceClientMock = vi.fn(() => ({
    from: (table: string) => {
      state.fromCalls.push(table);
      return {
        update: (patch: Record<string, unknown>) => {
          const filters: Record<string, unknown> = {};
          const q = {
            eq: (c: string, v: unknown) => ((filters[c] = v), q),
            then: (ok: (v: unknown) => unknown) => {
              state.stamps.push({ patch, filters });
              return Promise.resolve({ error: null }).then(ok);
            },
          };
          return q;
        },
        select: (_cols: string) => ({
          eq: (_col: string, val: string) => ({
            eq: () => ({
              order: () => ({
                limit: async () => {
                  if (state.throwOnGoalReadTenant === val) throw new Error("goal read boom");
                  if (state.goalsReadError) return { data: null, error: state.goalsReadError };
                  return { data: state.goalRowsByTenant[val] ?? [], error: null };
                },
              }),
            }),
          }),
          order: () => ({
            limit: async () => {
              if (table === "tenants") return { data: state.tenantRows, error: null };
              return { data: [], error: null };
            },
          }),
        }),
      };
    },
    rpc: (name: string, args: unknown) => {
      if (name === "update_goal_progress") {
        state.updateGoalCalls.push(args as { p_tenant_id: string; p_goal_id: string; p_current_value: number });
      }
      return state.rpcImpl(name, args);
    },
  }));

  const getBoolSettingMock = vi.fn(async (_key: string, tenant_id: string) => {
    if (state.throwOnSettingTenant === tenant_id) throw new Error("setting boom");
    return state.enabledByTenant[tenant_id] ?? false;
  });

  const enqueueAgentRunMock = vi.fn(async (input: Record<string, unknown>) => {
    state.enqueueCalls.push(input);
    return { run_id: "run-1" };
  });

  return { state, serviceClientMock, getBoolSettingMock, enqueueAgentRunMock };
});

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/settings", () => ({ getBoolSetting: mocks.getBoolSettingMock }));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: mocks.enqueueAgentRunMock }));
vi.mock("@/services/agents/visibility", () => ({
  getVisibleAgentSlugs: vi.fn(async () => new Set<string>()),
}));

import { runGoalReconcileSweep } from "../goal-reconcile";
import type { MeasureDeps } from "@/services/autopilot/goal-metric-resolver";
import type { MetricSnapshotRow } from "@/services/analytics/record-metric-snapshot";
import { schemaHashFor, type CountDeps } from "@/services/growth/goal-count-rule";

const NOW = new Date("2026-07-02T12:00:00Z");
const logger = { warn: vi.fn(), error: vi.fn() };

const noReadDeps: MeasureDeps = {
  readNativeStep: async () => null,
  readOperatorFunnelBookings: async () => null,
  readOperatorNewUsers: async () => null,
      readStripeMrr: async () => null,
};

function signupGoal(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "g-1",
    objective: "Grow weekly signups",
    target_metric: "signups",
    target_value: 100,
    baseline_value: null,
    current_value: null,
    due_date: null,
    priority: 80,
    created_at: null,
    measurement_mode: "auto",
    ...over,
  };
}

beforeEach(() => {
  vi.stubEnv("PRAXIS_DISABLE_CRON_STOP", "1");
  mocks.state.rpcImpl = async (name) => {
    if (name === "is_fleet_halted") return { data: false, error: null };
    return { data: null, error: null };
  };
  mocks.state.tenantRows = [];
  mocks.state.goalRowsByTenant = {};
  mocks.state.goalsReadError = null;
  mocks.state.fromCalls = [];
  mocks.state.updateGoalCalls = [];
  mocks.state.enabledByTenant = {};
  mocks.state.throwOnSettingTenant = null;
  mocks.state.throwOnGoalReadTenant = null;
  mocks.state.enqueueCalls = [];
  mocks.state.stamps = [];
  mocks.getBoolSettingMock.mockClear();
  mocks.enqueueAgentRunMock.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe("goal-reconcile — gate order", () => {
  it("fleet-halt RPC error FAILS CLOSED before any tenant work", async () => {
    mocks.state.rpcImpl = async (name) => {
      if (name === "is_fleet_halted") return { data: null, error: { message: "rpc down" } };
      return { data: null, error: null };
    };
    mocks.state.tenantRows = [{ id: "t-1" }];
    const res = await runGoalReconcileSweep(logger, noReadDeps, NOW);
    expect(res).toEqual({ skipped: true, reason: "fleet_kill_check_failed" });
    expect(mocks.state.fromCalls).not.toContain("tenants");
    expect(mocks.getBoolSettingMock).not.toHaveBeenCalled();
  });

  it("fleet halted → skip whole sweep, no tenant scan", async () => {
    mocks.state.rpcImpl = async (name) => {
      if (name === "is_fleet_halted") return { data: true, error: null };
      return { data: null, error: null };
    };
    const res = await runGoalReconcileSweep(logger, noReadDeps, NOW);
    expect(res).toEqual({ skipped: true, reason: "fleet_halted" });
    expect(mocks.state.fromCalls).not.toContain("tenants");
  });

  it("reconciles goals for a tenant that never had the autopilot opt-in", async () => {
    mocks.state.tenantRows = [{ id: "t-off" }];
    mocks.state.enabledByTenant = { "t-off": false };
    mocks.state.goalRowsByTenant = { "t-off": [signupGoal()] };
    await runGoalReconcileSweep(logger, noReadDeps, NOW);
    expect(mocks.state.fromCalls).toContain("autopilot_goals");
  });
});

const reads = (v: number | null): MeasureDeps => ({
  readNativeStep: async () => v,
  readOperatorFunnelBookings: async () => null,
  readOperatorNewUsers: async () => null,
  readStripeMrr: async () => null,
});

describe("goal-reconcile — measure, write the number, stamp when and from where", () => {
  it("writes the measured value and stamps its time and source", async () => {
    mocks.state.tenantRows = [{ id: "t-1" }];
    mocks.state.goalRowsByTenant = { "t-1": [signupGoal()] };
    const res = await runGoalReconcileSweep(logger, reads(60), NOW);
    expect(mocks.state.updateGoalCalls).toEqual([{ p_tenant_id: "t-1", p_goal_id: "g-1", p_current_value: 60 }]);
    expect(mocks.state.stamps).toHaveLength(1);
    expect(mocks.state.stamps[0].filters).toEqual({ id: "g-1", tenant_id: "t-1" });
    expect(mocks.state.stamps[0].patch.current_value_at).toBe(NOW.toISOString());
    expect(typeof mocks.state.stamps[0].patch.current_value_source).toBe("string");
    expect(res.measured).toBe(1);
    expect(res.tenants_reconciled).toBe(1);
  });

  it("wakes no agent, even for a goal far off track (cgo reviews goals from its own daily check)", async () => {
    mocks.state.tenantRows = [{ id: "t-1" }];
    mocks.state.goalRowsByTenant = { "t-1": [signupGoal()] };
    await runGoalReconcileSweep(logger, reads(1), NOW);
    expect(mocks.state.updateGoalCalls).toHaveLength(1);
    expect(mocks.state.enqueueCalls).toHaveLength(0);
    expect(mocks.enqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it("never writes a manual goal, even when its metric has a live source", async () => {
    mocks.state.tenantRows = [{ id: "t-1" }];
    mocks.state.goalRowsByTenant = {
      "t-1": [
        signupGoal({ id: "g-manual", measurement_mode: "manual_reported" }),
        signupGoal({ id: "g-unmapped", measurement_mode: "unmapped" }),
        signupGoal({ id: "g-auto" }),
      ],
    };
    const res = await runGoalReconcileSweep(logger, reads(60), NOW);
    expect(mocks.state.updateGoalCalls).toEqual([{ p_tenant_id: "t-1", p_goal_id: "g-auto", p_current_value: 60 }]);
    expect(mocks.state.stamps.map((x) => x.filters.id)).toEqual(["g-auto"]);
    expect(res.measured).toBe(1);
  });

  it("an unmeasurable goal gets no write and no stamp (never fabricates, and stays visibly stale)", async () => {
    mocks.state.tenantRows = [{ id: "t-1" }];
    mocks.state.goalRowsByTenant = {
      "t-1": [signupGoal({ id: "g-unresolved", target_metric: "arr_usd" }), signupGoal({ id: "g-nodata" })],
    };
    const res = await runGoalReconcileSweep(logger, noReadDeps, NOW);
    expect(mocks.state.updateGoalCalls).toHaveLength(0);
    expect(mocks.state.stamps).toHaveLength(0);
    expect(res.measured).toBe(0);
    expect(res.tenants_reconciled).toBe(1);
  });

  it("an 'auto' goal on a rate metric is moved to manual_reported; a reader-stamped count is dropped", async () => {
    mocks.state.tenantRows = [{ id: "t-1" }];
    mocks.state.goalRowsByTenant = {
      "t-1": [signupGoal({ id: "g-rate", target_metric: "activation_rate", current_value: 60, current_value_source: "native_funnel" })],
    };
    const res = await runGoalReconcileSweep(logger, reads(60), NOW);
    expect(mocks.state.updateGoalCalls).toHaveLength(0);
    expect(mocks.state.stamps).toEqual([
      {
        patch: { measurement_mode: "manual_reported", current_value: null, current_value_source: null },
        filters: { id: "g-rate", tenant_id: "t-1", measurement_mode: "auto" },
      },
    ]);
    expect(res.measured).toBe(0);
  });

  it.each([
    ["typed by the founder", "entered by the founder"],
    ["unstamped (legacy)", null],
  ])("moving a rate goal to manual keeps a number %s (it is then judged by its age)", async (_label, source) => {
    mocks.state.tenantRows = [{ id: "t-1" }];
    mocks.state.goalRowsByTenant = {
      "t-1": [signupGoal({ id: "g-rate", target_metric: "activation_rate", current_value: 0.4, current_value_source: source })],
    };
    await runGoalReconcileSweep(logger, reads(60), NOW);
    expect(mocks.state.stamps).toEqual([
      { patch: { measurement_mode: "manual_reported" }, filters: { id: "g-rate", tenant_id: "t-1", measurement_mode: "auto" } },
    ]);
  });

  it("a failed progress write leaves the old stamp (the number must not look fresh)", async () => {
    mocks.state.tenantRows = [{ id: "t-1" }];
    mocks.state.goalRowsByTenant = { "t-1": [signupGoal()] };
    mocks.state.rpcImpl = async (name) => {
      if (name === "is_fleet_halted") return { data: false, error: null };
      if (name === "update_goal_progress") return { data: null, error: { message: "write failed" } };
      return { data: null, error: null };
    };
    await runGoalReconcileSweep(logger, reads(60), NOW);
    expect(mocks.state.stamps).toHaveLength(0);
  });

  it("one tenant's failure never crashes the sweep (per-tenant isolation)", async () => {
    mocks.state.tenantRows = [{ id: "t-bad" }, { id: "t-good" }];
    mocks.state.throwOnGoalReadTenant = "t-bad";
    mocks.state.goalRowsByTenant = { "t-good": [signupGoal({ id: "g-2" })] };
    const res = await runGoalReconcileSweep(logger, reads(75), NOW);
    expect(res.errors).toBe(1);
    expect(res.measured).toBe(1);
    expect(mocks.state.updateGoalCalls).toEqual([{ p_tenant_id: "t-good", p_goal_id: "g-2", p_current_value: 75 }]);
  });
});

describe("goal-reconcile — counting rules", () => {
  const catalog = { tables: [{ name: "cars", rowEstimate: 3676, columns: [{ name: "ownerId", type: "string", nullable: false }] }] };
  const pipeline = [{ $group: { _id: "$ownerId" } }, { $count: "n" }];
  const HASH = schemaHashFor(catalog, { dialect: "mongodb", collection: "cars", pipeline })!;
  const rule = {
    dialect: "mongodb",
    source: "operator_db",
    collection: "cars",
    pipeline,
    definition: "hosts who ever listed a car, any listing status",
    schema_hash: HASH,
    confirmed_at: "2026-06-30T00:00:00Z",
    confirmed_by: "founder (email reply)",
  };
  const hostsGoal = (over: Record<string, unknown> = {}) =>
    signupGoal({ id: "g-hosts", target_metric: "total_hosts", measurement_mode: "manual_reported", current_value: 612, count_rule: rule, ...over });
  const counts = (result: { rows: Array<Record<string, unknown>>; truncated: boolean } | Error, cat = catalog) => {
    const tenants: string[] = [];
    const deps: CountDeps = {
      catalog: async (t) => (tenants.push(t), { dialect: "mongodb", catalog: cat, discovery_error: null }),
      mongoAggregate: async (t) => {
        tenants.push(t);
        if (result instanceof Error) throw result;
        return result;
      },
      sqlRead: async () => {
        throw new Error("unused");
      },
    };
    return { deps, tenants };
  };

  it("reruns the saved rule and writes the one number with how it was counted", async () => {
    mocks.state.tenantRows = [{ id: "t-1" }];
    mocks.state.goalRowsByTenant = { "t-1": [hostsGoal()] };
    const { deps, tenants } = counts({ rows: [{ n: 1522 }], truncated: false });
    const res = await runGoalReconcileSweep(logger, noReadDeps, NOW, deps);
    expect(mocks.state.updateGoalCalls).toEqual([{ p_tenant_id: "t-1", p_goal_id: "g-hosts", p_current_value: 1522 }]);
    expect(mocks.state.stamps).toEqual([
      {
        patch: { current_value_at: NOW.toISOString(), current_value_source: "counted: hosts who ever listed a car, any listing status" },
        filters: { id: "g-hosts", tenant_id: "t-1" },
      },
    ]);
    expect(res.measured).toBe(1);
    expect(new Set(tenants)).toEqual(new Set(["t-1"]));
  });

  it("an 'auto' rate goal with a confirmed rule is counted, never moved to manual or nulled", async () => {
    mocks.state.tenantRows = [{ id: "t-1" }];
    mocks.state.goalRowsByTenant = { "t-1": [hostsGoal({ target_metric: "activation_rate", measurement_mode: "auto" })] };
    await runGoalReconcileSweep(logger, noReadDeps, NOW, counts({ rows: [{ n: 1522 }], truncated: false }).deps);
    expect(mocks.state.updateGoalCalls).toEqual([{ p_tenant_id: "t-1", p_goal_id: "g-hosts", p_current_value: 1522 }]);
    expect(mocks.state.stamps.some((s) => "measurement_mode" in (s as { patch: object }).patch)).toBe(false);
  });

  it("a query error: no number written; the rule is marked stale for cgo to ask", async () => {
    mocks.state.tenantRows = [{ id: "t-1" }];
    mocks.state.goalRowsByTenant = { "t-1": [hostsGoal()] };
    await runGoalReconcileSweep(logger, noReadDeps, NOW, counts(new Error("mongo down")).deps);
    expect(mocks.state.updateGoalCalls).toEqual([]);
    expect(mocks.state.stamps).toEqual([
      { patch: { count_rule: { ...rule, stale_reason: "query_failed", stale_at: NOW.toISOString() } }, filters: { id: "g-hosts", tenant_id: "t-1" } },
    ]);
  });

  it("a schema change: the rule is not run, no number is written, it is marked stale", async () => {
    mocks.state.tenantRows = [{ id: "t-1" }];
    mocks.state.goalRowsByTenant = { "t-1": [hostsGoal()] };
    const retyped = { tables: [{ name: "cars", rowEstimate: 1, columns: [{ name: "ownerId", type: "objectId", nullable: false }] }] };
    const c = counts({ rows: [{ n: 1522 }], truncated: false }, retyped);
    await runGoalReconcileSweep(logger, noReadDeps, NOW, c.deps);
    expect(mocks.state.updateGoalCalls).toEqual([]);
    expect(mocks.state.stamps[0].patch).toMatchObject({ count_rule: { stale_reason: "schema_changed" } });
  });

  it("a non-numeric or multi-row result writes nothing; an unconfirmed rule is never run", async () => {
    mocks.state.tenantRows = [{ id: "t-1" }];
    mocks.state.goalRowsByTenant = { "t-1": [hostsGoal()] };
    await runGoalReconcileSweep(logger, noReadDeps, NOW, counts({ rows: [{ n: 1 }, { n: 2 }], truncated: false }).deps);
    expect(mocks.state.updateGoalCalls).toEqual([]);
    expect(mocks.state.stamps[0].patch).toMatchObject({ count_rule: { stale_reason: "not_one_number" } });

    mocks.state.stamps = [];
    mocks.state.goalRowsByTenant = { "t-1": [hostsGoal({ count_rule: { ...rule, confirmed_at: null } })] };
    const c = counts({ rows: [{ n: 5 }], truncated: false });
    await runGoalReconcileSweep(logger, noReadDeps, NOW, c.deps);
    expect(c.tenants).toEqual([]);
    expect(mocks.state.updateGoalCalls).toEqual([]);
    expect(mocks.state.stamps).toEqual([]);
  });

  it("a count that works again clears the stale mark", async () => {
    mocks.state.tenantRows = [{ id: "t-1" }];
    mocks.state.goalRowsByTenant = { "t-1": [hostsGoal({ count_rule: { ...rule, stale_reason: "query_failed", stale_at: "2026-07-01T13:30:00Z" } })] };
    await runGoalReconcileSweep(logger, noReadDeps, NOW, counts({ rows: [{ n: 1530 }], truncated: false }).deps);
    expect(mocks.state.updateGoalCalls).toHaveLength(1);
    expect(mocks.state.stamps[0].patch).toMatchObject({ count_rule: { stale_reason: null, stale_at: null } });
  });
});
