
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const state: {
    halted: boolean | null;
    haltErr: { message: string } | null;
    tenantRows: Array<{ id: string }>;
    enabledByTenant: Record<string, boolean>;
    manualRunsByTenant: Record<string, unknown[]>;
    scheduledSlugsByTenant: Record<string, string[]>;
    recentProposalCountByTenant: Record<string, number>;
    emitResult: { data: unknown; error: { message: string } | null };
    emitCalls: Array<Record<string, unknown>>;
    scheduleWrites: number;
    runEnqueues: number;
    queriedTenantIds: { agent_runs: string[]; schedules: string[]; decisions: string[] };
  } = {
    halted: false,
    haltErr: null,
    tenantRows: [],
    enabledByTenant: {},
    manualRunsByTenant: {},
    scheduledSlugsByTenant: {},
    recentProposalCountByTenant: {},
    emitResult: { data: "decision-new-1", error: null },
    emitCalls: [],
    scheduleWrites: 0,
    runEnqueues: 0,
    queriedTenantIds: { agent_runs: [], schedules: [], decisions: [] },
  };

  function tableApi(table: string) {
    return {
      select: (_cols: string, _opts?: unknown) => {
        let capturedTenant: string | null = null;
        const chain: Record<string, unknown> = {};
        chain.eq = (col: string, val: string) => {
          if (col === "tenant_id") {
            capturedTenant = val;
            if (table === "agent_runs") state.queriedTenantIds.agent_runs.push(val);
            if (table === "tenant_agent_schedules") state.queriedTenantIds.schedules.push(val);
            if (table === "decisions") state.queriedTenantIds.decisions.push(val);
          }
          return chain;
        };
        chain.gte = () => chain;
        chain.order = () => chain;
        chain.limit = async () => {
          if (table === "tenants") return { data: state.tenantRows, error: null };
          if (table === "agent_runs") {
            return { data: state.manualRunsByTenant[capturedTenant ?? ""] ?? [], error: null };
          }
          return { data: [], error: null };
        };
        chain.then = (resolve: (v: unknown) => void) => {
          if (table === "tenant_agent_schedules") {
            const slugs = state.scheduledSlugsByTenant[capturedTenant ?? ""] ?? [];
            resolve({ data: slugs.map((s) => ({ agent_slug: s })), error: null });
            return;
          }
          if (table === "decisions") {
            const count = state.recentProposalCountByTenant[capturedTenant ?? ""] ?? 0;
            resolve({ count, error: null });
            return;
          }
          resolve({ data: [], error: null });
        };
        return chain;
      },
      insert: () => {
        if (table === "tenant_agent_schedules") state.scheduleWrites += 1;
        return { select: () => ({ single: async () => ({ data: null, error: null }) }) };
      },
      upsert: () => {
        if (table === "tenant_agent_schedules") state.scheduleWrites += 1;
        return Promise.resolve({ error: null });
      },
    };
  }

  const serviceClientMock = vi.fn(() => ({
    from: (table: string) => tableApi(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "is_fleet_halted") {
        if (state.haltErr) return { data: null, error: state.haltErr };
        return { data: state.halted, error: null };
      }
      if (name === "emit_decision") {
        state.emitCalls.push(args);
        return { data: state.emitResult.data, error: state.emitResult.error };
      }
      return { data: null, error: null };
    },
  }));

  const getBoolSettingMock = vi.fn(async (_key: string, tenant_id?: string | null) => {
    return state.enabledByTenant[tenant_id ?? ""] ?? false;
  });

  return { state, serviceClientMock, getBoolSettingMock };
});

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/settings", () => ({ getBoolSetting: mocks.getBoolSettingMock }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(), LOG_META_KEYS: [] }));

import {
  pickStrongestCandidate,
  buildProposalBody,
  renderProposalPreview,
  proposeAutomationForTenant,
  runCompanyBrainHeartbeat,
  HEARTBEAT_DECISION_CLASS,
  HEARTBEAT_DEFAULT_CRON,
  HEARTBEAT_MIN_RUNS,
  HEARTBEAT_MIN_DISTINCT_DAYS,
} from "../company-brain-heartbeat";

const silentLogger = { warn: () => {}, info: () => {}, error: () => {} };

function resetState() {
  mocks.state.halted = false;
  mocks.state.haltErr = null;
  mocks.state.tenantRows = [];
  mocks.state.enabledByTenant = {};
  mocks.state.manualRunsByTenant = {};
  mocks.state.scheduledSlugsByTenant = {};
  mocks.state.recentProposalCountByTenant = {};
  mocks.state.emitResult = { data: "decision-new-1", error: null };
  mocks.state.emitCalls = [];
  mocks.state.scheduleWrites = 0;
  mocks.state.runEnqueues = 0;
  mocks.state.queriedTenantIds = { agent_runs: [], schedules: [], decisions: [] };
  mocks.serviceClientMock.mockClear();
  mocks.getBoolSettingMock.mockClear();
}

function manualRuns(slug: string, days: number, runsPerDay = 1, trigger = "manual") {
  const out: Array<{ id: string; agent_slug: string; trigger: string; enqueued_at: string }> = [];
  for (let d = 0; d < days; d++) {
    for (let r = 0; r < runsPerDay; r++) {
      out.push({
        id: `${slug}-${d}-${r}`,
        agent_slug: slug,
        trigger,
        enqueued_at: `2026-06-${String(10 + d).padStart(2, "0")}T0${r}:00:00.000Z`,
      });
    }
  }
  return out;
}

describe("company-brain-heartbeat — pickStrongestCandidate (pure)", () => {
  it("qualifies an agent run manually on a cadence (>=MIN_RUNS over >=MIN_DISTINCT_DAYS)", () => {
    const runs = manualRuns("operator", HEARTBEAT_MIN_DISTINCT_DAYS, 1);
    const c = pickStrongestCandidate(runs, new Set());
    expect(c).not.toBeNull();
    expect(c!.agent_slug).toBe("operator");
    expect(c!.distinct_days).toBe(HEARTBEAT_MIN_DISTINCT_DAYS);
    expect(c!.run_count).toBe(HEARTBEAT_MIN_RUNS);
    expect(c!.source_run_ids.length).toBeGreaterThan(0);
  });

  it("rejects a BURST (enough runs but all on ONE day — not a cadence)", () => {
    const runs = manualRuns("operator", 1, HEARTBEAT_MIN_RUNS + 2);
    expect(pickStrongestCandidate(runs, new Set())).toBeNull();
  });

  it("rejects too-few runs even across many days", () => {
    const runs = [
      { id: "a", agent_slug: "pm", trigger: "manual", enqueued_at: "2026-06-10T00:00:00Z" },
      { id: "b", agent_slug: "pm", trigger: "manual", enqueued_at: "2026-06-11T00:00:00Z" },
    ];
    expect(pickStrongestCandidate(runs, new Set())).toBeNull();
  });

  it("excludes an agent that ALREADY has a schedule row (no duplicate proposal)", () => {
    const runs = manualRuns("operator", HEARTBEAT_MIN_DISTINCT_DAYS, 1);
    expect(pickStrongestCandidate(runs, new Set(["operator"]))).toBeNull();
  });

  it("ignores non-manual (cron/webhook) runs as automation signal", () => {
    const runs = manualRuns("operator", HEARTBEAT_MIN_DISTINCT_DAYS, 1, "cron");
    expect(pickStrongestCandidate(runs, new Set())).toBeNull();
  });

  it("picks the SINGLE strongest candidate (most distinct days) when several qualify", () => {
    const weak = manualRuns("pm", HEARTBEAT_MIN_DISTINCT_DAYS, 1);
    const strong = manualRuns("operator", HEARTBEAT_MIN_DISTINCT_DAYS + 2, 1);
    const c = pickStrongestCandidate([...weak, ...strong], new Set());
    expect(c!.agent_slug).toBe("operator");
  });
});

describe("company-brain-heartbeat — proposal body (pure)", () => {
  it("buildProposalBody carries the schedule fields + provenance", () => {
    const c = { agent_slug: "operator", run_count: 4, distinct_days: 3, source_run_ids: ["r1", "r2"] };
    const body = buildProposalBody(c, HEARTBEAT_DEFAULT_CRON) as Record<string, unknown>;
    expect(body.agent_slug).toBe("operator");
    expect(body.cron_expression).toBe(HEARTBEAT_DEFAULT_CRON);
    expect(typeof body.objective).toBe("string");
    expect((body.pattern as { source_run_ids: string[] }).source_run_ids).toEqual(["r1", "r2"]);
    expect(body.source).toBe("company-brain-heartbeat");
    expect(renderProposalPreview(c, HEARTBEAT_DEFAULT_CRON)).toMatch(/operator/);
  });
});

describe("company-brain-heartbeat — proposeAutomationForTenant (gated pipeline)", () => {
  beforeEach(resetState);

  it("flag OFF → NO decision emitted (SAFE-INERT)", async () => {
    mocks.state.enabledByTenant = { "tenant-A": false };
    mocks.state.manualRunsByTenant = { "tenant-A": manualRuns("operator", 4, 1) };
    const out = await proposeAutomationForTenant("tenant-A");
    expect(out.status).toBe("skipped_disabled");
    expect(mocks.state.emitCalls.length).toBe(0);
  });

  it("flag ON + qualifying pattern → exactly ONE proposed decision (NOT executed)", async () => {
    mocks.state.enabledByTenant = { "tenant-A": true };
    mocks.state.manualRunsByTenant = { "tenant-A": manualRuns("operator", 4, 1) };
    const out = await proposeAutomationForTenant("tenant-A");
    expect(out.status).toBe("proposed");
    expect(mocks.state.emitCalls.length).toBe(1);
    expect(mocks.state.emitCalls[0].p_decision_class).toBe(HEARTBEAT_DECISION_CLASS);
    expect(mocks.state.scheduleWrites).toBe(0);
    expect(mocks.state.runEnqueues).toBe(0);
  });

  it("RATE-LIMIT: an open recent proposal already exists → no second proposal", async () => {
    mocks.state.enabledByTenant = { "tenant-A": true };
    mocks.state.manualRunsByTenant = { "tenant-A": manualRuns("operator", 4, 1) };
    mocks.state.recentProposalCountByTenant = { "tenant-A": 1 };
    const out = await proposeAutomationForTenant("tenant-A");
    expect(out.status).toBe("skipped_rate_limited");
    expect(mocks.state.emitCalls.length).toBe(0);
  });

  it("flag ON but no qualifying pattern → no proposal", async () => {
    mocks.state.enabledByTenant = { "tenant-A": true };
    mocks.state.manualRunsByTenant = { "tenant-A": manualRuns("operator", 1, 5) };
    const out = await proposeAutomationForTenant("tenant-A");
    expect(out.status).toBe("skipped_no_pattern");
    expect(mocks.state.emitCalls.length).toBe(0);
  });

  it("C8: every scan query for the tenant filters on the DB tenant id (never a payload)", async () => {
    mocks.state.enabledByTenant = { "tenant-A": true };
    mocks.state.manualRunsByTenant = { "tenant-A": manualRuns("operator", 4, 1) };
    await proposeAutomationForTenant("tenant-A");
    expect(mocks.state.queriedTenantIds.agent_runs).toContain("tenant-A");
    expect(mocks.state.queriedTenantIds.schedules).toContain("tenant-A");
    expect(mocks.state.queriedTenantIds.decisions).toContain("tenant-A");
    expect(mocks.state.emitCalls[0].p_tenant_id).toBe("tenant-A");
  });

  it("emit_decision error → status:error (does NOT swallow, does NOT schedule)", async () => {
    mocks.state.enabledByTenant = { "tenant-A": true };
    mocks.state.manualRunsByTenant = { "tenant-A": manualRuns("operator", 4, 1) };
    mocks.state.emitResult = { data: null, error: { message: "rpc boom" } };
    const out = await proposeAutomationForTenant("tenant-A");
    expect(out.status).toBe("error");
    expect(mocks.state.scheduleWrites).toBe(0);
  });
});

describe("company-brain-heartbeat — sweep (gate-stack)", () => {
  beforeEach(resetState);

  it("fleet halted → sweep skipped, nothing proposed", async () => {
    mocks.state.halted = true;
    mocks.state.tenantRows = [{ id: "tenant-A" }];
    mocks.state.enabledByTenant = { "tenant-A": true };
    mocks.state.manualRunsByTenant = { "tenant-A": manualRuns("operator", 4, 1) };
    const res = await runCompanyBrainHeartbeat(silentLogger);
    expect(res.halted).toBe(true);
    expect(mocks.state.emitCalls.length).toBe(0);
  });

  it("is_fleet_halted RPC error → FAIL-CLOSED (sweep skipped)", async () => {
    mocks.state.haltErr = { message: "kill check down" };
    mocks.state.tenantRows = [{ id: "tenant-A" }];
    mocks.state.enabledByTenant = { "tenant-A": true };
    const res = await runCompanyBrainHeartbeat(silentLogger);
    expect(res.halted).toBe(true);
    expect(mocks.state.emitCalls.length).toBe(0);
  });

  it("multi-tenant: ONE proposal each for enabled+qualifying, skips the rest", async () => {
    mocks.state.tenantRows = [{ id: "t-on" }, { id: "t-off" }, { id: "t-nopattern" }];
    mocks.state.enabledByTenant = { "t-on": true, "t-off": false, "t-nopattern": true };
    mocks.state.manualRunsByTenant = {
      "t-on": manualRuns("operator", 4, 1),
      "t-nopattern": manualRuns("operator", 1, 5),
    };
    const res = await runCompanyBrainHeartbeat(silentLogger);
    expect(res.scanned).toBe(3);
    expect(res.proposed).toBe(1);
    expect(res.skipped_disabled).toBe(1);
    expect(res.skipped_no_pattern).toBe(1);
    expect(mocks.state.emitCalls.length).toBe(1);
    expect(mocks.state.scheduleWrites).toBe(0);
  });
});

describe("company-brain-heartbeat — no-auto-act source contract", () => {
  it("worker source NEVER imports an agent-run/work-queue enqueue path", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../company-brain-heartbeat.ts"), "utf-8");
    expect(src).not.toMatch(/enqueueAgentRun/);
    expect(src).not.toMatch(/enqueueWorkItem/);
    expect(src).not.toMatch(/inngest\.send/);
    expect(src).toMatch(/emit_decision/);
    expect(src).toMatch(/is_fleet_halted/);
    expect(src).toMatch(/memory_heartbeat_enabled/);
    expect(src).toMatch(/cron:\s*"40 8 \* \* \*"/);
    expect(src).toMatch(/concurrency:\s*1/);
  });
});
