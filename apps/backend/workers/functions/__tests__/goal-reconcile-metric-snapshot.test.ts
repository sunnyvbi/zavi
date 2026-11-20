
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const state: {
    rpcImpl: (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>;
    tenantRows: Array<{ id: string }>;
    goalRowsByTenant: Record<string, unknown[]>;
    updateGoalCalls: Array<{ p_tenant_id: string; p_goal_id: string; p_current_value: number }>;
    updateGoalError: { message: string } | null;
    enabledByTenant: Record<string, boolean>;
    enqueueCalls: Array<Record<string, unknown>>;
    snapshotCalls: Array<Record<string, unknown>>;
    snapshotThrows: boolean;
    classifyResult: string | null;
    classifyCalls: string[];
  } = {
    rpcImpl: async () => ({ data: null, error: null }),
    tenantRows: [],
    goalRowsByTenant: {},
    updateGoalCalls: [],
    updateGoalError: null,
    enabledByTenant: {},
    enqueueCalls: [],
    snapshotCalls: [],
    snapshotThrows: false,
    classifyResult: "weekly_signups",
    classifyCalls: [],
  };

  const serviceClientMock = vi.fn(() => ({
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, val: string) => ({
          eq: () => ({
            order: () => ({
              limit: async () => ({ data: state.goalRowsByTenant[val] ?? [], error: null }),
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
    }),
    rpc: (name: string, args: unknown) => {
      if (name === "update_goal_progress") {
        state.updateGoalCalls.push(args as { p_tenant_id: string; p_goal_id: string; p_current_value: number });
        if (state.updateGoalError) {
          return Promise.resolve({ data: null, error: state.updateGoalError });
        }
      }
      return state.rpcImpl(name, args);
    },
  }));

  const getBoolSettingMock = vi.fn(
    async (_key: string, tenant_id: string) => state.enabledByTenant[tenant_id] ?? false,
  );

  const enqueueAgentRunMock = vi.fn(async (input: Record<string, unknown>) => {
    state.enqueueCalls.push(input);
    return { run_id: "run-1" };
  });

  const recordMetricSnapshotMock = vi.fn(async (input: Record<string, unknown>) => {
    if (state.snapshotThrows) throw new Error("snapshot boom");
    state.snapshotCalls.push(input);
  });

  const classifyGoalMetricKeyMock = vi.fn((text: string) => {
    state.classifyCalls.push(text);
    return state.classifyResult;
  });

  return {
    state,
    serviceClientMock,
    getBoolSettingMock,
    enqueueAgentRunMock,
    recordMetricSnapshotMock,
    classifyGoalMetricKeyMock,
  };
});

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/settings", () => ({ getBoolSetting: mocks.getBoolSettingMock }));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: mocks.enqueueAgentRunMock }));
vi.mock("@/services/agents/visibility", () => ({
  getVisibleAgentSlugs: vi.fn(async () => new Set<string>()),
}));
vi.mock("@/services/analytics/metric-registry", () => ({
  classifyGoalMetricKey: mocks.classifyGoalMetricKeyMock,
}));
vi.mock("@/services/analytics/record-metric-snapshot", () => ({
  recordMetricSnapshot: mocks.recordMetricSnapshotMock,
  readMetricHistory: async () => [],
}));

import { runGoalReconcileSweep } from "../goal-reconcile";
import type { MeasureDeps } from "@/services/autopilot/goal-metric-resolver";

const NOW = new Date("2026-07-02T12:34:56.789Z");
const logger = { warn: vi.fn(), error: vi.fn() };

const measuredDeps: MeasureDeps = {
  readNativeStep: async () => null,
  readOperatorFunnelBookings: async () => null,
  readOperatorNewUsers: async () => 42,
      readStripeMrr: async () => null,
};

const unmeasuredDeps: MeasureDeps = {
  readNativeStep: async () => null,
  readOperatorFunnelBookings: async () => null,
  readOperatorNewUsers: async () => null,
      readStripeMrr: async () => null,
};

function seedGoal() {
  mocks.state.tenantRows = [{ id: "t1" }];
  mocks.state.enabledByTenant = { t1: true };
  mocks.state.goalRowsByTenant = {
    t1: [
      {
        id: "goal-1",
        objective: "Grow weekly signups",
        target_metric: "weekly signups",
        target_value: 10,
        baseline_value: null,
        current_value: null,
        due_date: null,
        priority: 50,
        created_at: "2026-06-01T00:00:00Z",
        measurement_mode: "auto",
      },
    ],
  };
}

beforeEach(() => {
  mocks.state.rpcImpl = async () => ({ data: null, error: null });
  mocks.state.tenantRows = [];
  mocks.state.goalRowsByTenant = {};
  mocks.state.updateGoalCalls = [];
  mocks.state.updateGoalError = null;
  mocks.state.enabledByTenant = {};
  mocks.state.enqueueCalls = [];
  mocks.state.snapshotCalls = [];
  mocks.state.snapshotThrows = false;
  mocks.state.classifyResult = "weekly_signups";
  mocks.state.classifyCalls = [];
  mocks.recordMetricSnapshotMock.mockClear();
  mocks.classifyGoalMetricKeyMock.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe("goal-reconcile metric-snapshot piggyback", () => {
  it("records one snapshot after a successful measurement (mapped key, outcome source, hour-truncated rolling_7d window)", async () => {
    seedGoal();
    const res = await runGoalReconcileSweep(logger, measuredDeps, NOW);
    expect(res.measured).toBe(1);
    expect(mocks.state.updateGoalCalls).toEqual([
      { p_tenant_id: "t1", p_goal_id: "goal-1", p_current_value: 42 },
    ]);
    expect(mocks.state.classifyCalls).toEqual(["weekly signups"]);
    expect(mocks.state.snapshotCalls).toHaveLength(1);
    const snap = mocks.state.snapshotCalls[0];
    expect(snap.tenant_id).toBe("t1");
    expect(snap.metric_key).toBe("weekly_signups");
    expect(snap.value).toBe(42);
    expect(snap.status).toBe("measured");
    expect(snap.source).toBe("operator_db_signups");
    expect(snap.window_kind).toBe("rolling_7d");
    expect(snap.window_end).toBe("2026-07-02T12:00:00.000Z");
    expect(snap.window_start).toBe("2026-06-25T12:00:00.000Z");
    expect((snap.meta as { goal_id?: string }).goal_id).toBe("goal-1");
  });

  it("classifyGoalMetricKey → null skips the snapshot (goal update untouched)", async () => {
    seedGoal();
    mocks.state.classifyResult = null;
    const res = await runGoalReconcileSweep(logger, measuredDeps, NOW);
    expect(res.measured).toBe(1);
    expect(mocks.state.updateGoalCalls).toHaveLength(1);
    expect(mocks.recordMetricSnapshotMock).not.toHaveBeenCalled();
  });

  it("an ARR goal never writes its annualized value into the monthly stripe_mrr history", async () => {
    seedGoal();
    (mocks.state.goalRowsByTenant.t1[0] as Record<string, unknown>).target_metric = "ARR";
    mocks.state.classifyResult = "stripe_mrr";
    const res = await runGoalReconcileSweep(
      logger,
      { ...unmeasuredDeps, readStripeMrr: async () => 1000 },
      NOW,
    );
    expect(res.measured).toBe(1);
    expect(mocks.state.updateGoalCalls[0].p_current_value).toBe(12000);
    expect(mocks.recordMetricSnapshotMock).not.toHaveBeenCalled();
  });

  it("does NOT snapshot unmeasured goals", async () => {
    seedGoal();
    const res = await runGoalReconcileSweep(logger, unmeasuredDeps, NOW);
    expect(res.measured).toBe(0);
    expect(mocks.recordMetricSnapshotMock).not.toHaveBeenCalled();
  });

  it("a throwing snapshot helper never affects the goal update or the sweep result", async () => {
    seedGoal();
    mocks.state.snapshotThrows = true;
    const res = await runGoalReconcileSweep(logger, measuredDeps, NOW);
    expect(res.measured).toBe(1);
    expect(res.errors).toBe(0);
    expect(mocks.state.updateGoalCalls).toEqual([
      { p_tenant_id: "t1", p_goal_id: "goal-1", p_current_value: 42 },
    ]);
  });

  it("snapshots even when update_goal_progress errors (the measurement is still real)", async () => {
    seedGoal();
    mocks.state.updateGoalError = { message: "rpc down" };
    const res = await runGoalReconcileSweep(logger, measuredDeps, NOW);
    expect(res.measured).toBe(1);
    expect(res.errors).toBe(1);
    expect(mocks.state.snapshotCalls).toHaveLength(1);
  });
});
