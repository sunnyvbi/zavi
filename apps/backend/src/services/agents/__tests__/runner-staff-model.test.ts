import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  parentRuns: {} as Record<string, { tenant_id: string; payload: Record<string, unknown> }>,
  cap: { ok: true } as { ok: true } | { ok: false; spent: number; cap: number },
  rpcArgs: [] as Array<Record<string, unknown>>,
  ensureCalls: 0,
  consumeCalls: 0,
}));

vi.mock("../deepagent", () => ({ LangChainDeepAgentEngine: class {} }));
vi.mock("../fleet-halt", async (orig) => ({
  ...(await orig<typeof import("../fleet-halt")>()),
  isFleetHalted: async () => false,
}));
vi.mock("../registry", async (orig) => ({
  ...(await orig<typeof import("../registry")>()),
  loadAgentDefinition: async (slug: string) => ({
    slug,
    content_hash: "h",
    metadata_praxis: { manual_only: true, side_effects: false, cost_class: "cheap", requires_sandbox: false },
  }),
}));
vi.mock("@/services/sandbox/sandbox-enablement-flag", async (orig) => ({
  ...(await orig<typeof import("@/services/sandbox/sandbox-enablement-flag")>()),
  resolveSandboxMode: async () => ({ requires_sandbox: false, lazyEligible: false }),
}));
vi.mock("../budget", async (orig) => ({
  ...(await orig<typeof import("../budget")>()),
  resolveDailyCapUsd: async () => 100,
  consumeBudgetOrReject: async () => {
    m.consumeCalls += 1;
    return true;
  },
}));
vi.mock("../ensure-runnable", async (orig) => ({
  ...(await orig<typeof import("../ensure-runnable")>()),
  ensureAgentRunnable: async (_t: string, slug: string) => {
    m.ensureCalls += 1;
    return { runnable: true, agent: { slug } };
  },
}));
vi.mock("@/services/auth/staff-model-access", () => ({
  checkStaffModelCap: async () => m.cap,
}));
vi.mock("@/services/analytics/mixpanel", () => ({ track: () => {} }));
vi.mock("@/services/logging/logEvent", async (orig) => ({
  ...(await orig<typeof import("@/services/logging/logEvent")>()),
  logEvent: async () => {},
}));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: async () => {} }));
vi.mock("@/services/supabase", () => {
  const client = {
    rpc: async (_name: string, args: Record<string, unknown>) => {
      m.rpcArgs.push(args);
      return { data: "run-1", error: null };
    },
    from: (_table: string) => {
      const f: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          f[col] = val;
          return q;
        },
        maybeSingle: async () => {
          const row = m.parentRuns[f.id as string];
          return { data: row && row.tenant_id === f.tenant_id ? { payload: row.payload } : null, error: null };
        },
        update: () => q,
        then: (r: (v: { error: null }) => void) => r({ error: null }),
        insert: async () => ({ error: null }),
      };
      return q;
    },
  };
  return { serviceClient: () => client, serverClientFromBearer: () => client };
});

import { enqueueAgentRun } from "../runner";
import { StaffModelCapError } from "../staff-model-inherit";

const T = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  for (const k of Object.keys(m.parentRuns)) delete m.parentRuns[k];
  m.cap = { ok: true };
  m.rpcArgs.length = 0;
  m.ensureCalls = 0;
  m.consumeCalls = 0;
});

describe("enqueueAgentRun — staff ?model= inheritance", () => {
  it("cap reached → StaffModelCapError BEFORE ensureAgentRunnable and consumeBudgetOrReject", async () => {
    m.parentRuns["p1"] = { tenant_id: T, payload: { staff_model: { key: "qwen" } } };
    m.cap = { ok: false, spent: 200, cap: 200 };
    const err = await enqueueAgentRun({ tenant_id: T, agent_slug: "research", trigger: "handoff", payload: {}, parent_run_id: "p1" }).catch((e) => e);
    expect(err).toBeInstanceOf(StaffModelCapError);
    expect(m.ensureCalls).toBe(0);
    expect(m.consumeCalls).toBe(0);
    expect(m.rpcArgs).toHaveLength(0);
  });

  it("inherits the parent's key onto the enqueued payload (harness: reservation path ran)", async () => {
    m.parentRuns["p1"] = { tenant_id: T, payload: { staff_model: { key: "qwen" } } };
    await enqueueAgentRun({ tenant_id: T, agent_slug: "research", trigger: "handoff", payload: { intent: "x" }, parent_run_id: "p1" });
    expect(m.consumeCalls).toBe(1);
    const p = m.rpcArgs[0]?.p_payload as Record<string, unknown>;
    expect(p).toMatchObject({ intent: "x", staff_model: { key: "qwen" } });
  });

  it("no parent_run_id (cron / reminder) → no staff_model even if a staff run exists", async () => {
    m.parentRuns["p1"] = { tenant_id: T, payload: { staff_model: { key: "qwen" } } };
    await enqueueAgentRun({ tenant_id: T, agent_slug: "research", trigger: "cron", payload: { intent: "x" } });
    expect((m.rpcArgs[0]?.p_payload as Record<string, unknown>).staff_model).toBeUndefined();
  });

  it("parent in another tenant → no staff_model", async () => {
    m.parentRuns["p1"] = { tenant_id: "other", payload: { staff_model: { key: "qwen" } } };
    await enqueueAgentRun({ tenant_id: T, agent_slug: "research", trigger: "handoff", payload: {}, parent_run_id: "p1" });
    expect((m.rpcArgs[0]?.p_payload as Record<string, unknown>).staff_model).toBeUndefined();
  });

  it("a caller-supplied staff_model (POST /run, a2a, MCP, copied payload) is dropped: no forging", async () => {
    await enqueueAgentRun({ tenant_id: T, agent_slug: "research", trigger: "manual", payload: { intent: "x", staff_model: { key: "qwen" } } });
    const p = m.rpcArgs[0]?.p_payload as Record<string, unknown>;
    expect(p.staff_model).toBeUndefined();
    expect(p.intent).toBe("x");
  });

  it("a forged staff_model with a parent that has none → still none", async () => {
    m.parentRuns["p1"] = { tenant_id: T, payload: {} };
    await enqueueAgentRun({ tenant_id: T, agent_slug: "research", trigger: "handoff", payload: { staff_model: { key: "kimi" } }, parent_run_id: "p1" });
    expect((m.rpcArgs[0]?.p_payload as Record<string, unknown>).staff_model).toBeUndefined();
  });
});
