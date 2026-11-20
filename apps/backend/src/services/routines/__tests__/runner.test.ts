
import { describe, it, expect, vi } from "vitest";
import {
  runTenantRoutine,
  HARD_STEP_CEILING,
  type RoutineRunnerDeps,
  type RoutineRunnerDb,
  type RoutineRunnerQuery,
} from "../runner";
import { effectiveDeclaredTools } from "@/services/mcp/write-allowlist";
import { hashValidatedRoutineSpec } from "../routine-spec-hash";

const RUN_ID = "run-1";
const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";

function makeDb(tables: {
  agent_runs: Record<string, unknown>[];
  tenant_routines: Record<string, unknown>[];
}): RoutineRunnerDb {
  function query(table: string): RoutineRunnerQuery {
    const filters: Record<string, unknown> = {};
    const builder: RoutineRunnerQuery = {
      select() {
        return builder;
      },
      eq(col, val) {
        filters[col] = val;
        return builder;
      },
      async maybeSingle() {
        const rows = (tables as Record<string, Record<string, unknown>[]>)[table].filter((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        return { data: rows[0] ?? null, error: null };
      },
    };
    return builder;
  }
  return { from: query };
}

function deps(
  over: {
    routine?: Record<string, unknown>;
    liveTools?: string[];
    resolvedTools?: string[];
    callStep?: RoutineRunnerDeps["callStep"];
    runAgent?: string;
    untrusted_inbound?: boolean;
  } = {},
): { deps: RoutineRunnerDeps; calls: Array<{ server: string; tool: string; idx: number }> } {
  const calls: Array<{ server: string; tool: string; idx: number }> = [];
  const agentSlug = over.runAgent ?? "cto-engineer";
  const routine = over.routine ?? {
    id: "routine-1",
    tenant_id: TENANT_A,
    agent_slug: "cto-engineer",
    status: "approved",
    emitted_tool_name: "tenant_skill__cto-engineer__abc12345",
    routine_spec: {
      type: "tool_sequence",
      steps: [{ tool: "github__get_repo", args: { repo: "x" } }],
    },
    granted_tool_names: ["github__get_repo"],
    provenance_agent_def_hash: "hash-old",
  };
  const db = makeDb({
    agent_runs: [{ id: RUN_ID, tenant_id: TENANT_A, agent_slug: agentSlug }],
    tenant_routines: [routine],
  });
  const callStep =
    over.callStep ??
    (async (server_id: string, tool_name: string, _args: unknown, step_idx: number) => {
      calls.push({ server: server_id, tool: tool_name, idx: step_idx });
      return { is_error: false, content: JSON.stringify({ ok: true }) };
    });
  const liveTools = over.liveTools ?? ["github__get_repo"];
  return {
    calls,
    deps: {
      db,
      loadLiveAgentDef: async () => ({
        tools: liveTools,
        def_hash: "hash-new",
      }),
      callStep,
      resolveRunTools: async () =>
        over.resolvedTools ?? effectiveDeclaredTools(liveTools),
    },
  };
}

describe("runTenantRoutine — happy path + tenant re-derivation", () => {
  it("re-derives tenant+agent from the run, loads the approved routine, and runs the granted step", async () => {
    const { deps: d, calls } = deps();
    const r = await runTenantRoutine(
      { run_id: RUN_ID, emitted_tool_name: "tenant_skill__cto-engineer__abc12345" },
      d,
    );
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ server: "github", tool: "get_repo", idx: 0 }]);
  });

  it("plumbs a DISTINCT step_idx to callStep for each step (per-step ledger key)", async () => {
    const { deps: d, calls } = deps({
      routine: {
        id: "routine-1",
        tenant_id: TENANT_A,
        agent_slug: "cto-engineer",
        status: "approved",
        emitted_tool_name: "tenant_skill__cto-engineer__abc12345",
        routine_spec: {
          type: "tool_sequence",
          steps: [
            { tool: "github__get_repo", args: { a: 1 } },
            { tool: "github__get_repo", args: { a: 2 } },
          ],
        },
        granted_tool_names: ["github__get_repo"],
        provenance_agent_def_hash: "h",
      },
    });
    const r = await runTenantRoutine({ run_id: RUN_ID, emitted_tool_name: "tenant_skill__cto-engineer__abc12345" }, d);
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.idx)).toEqual([0, 1]);
  });

  it("fails when the run does not exist (cannot re-derive tenant)", async () => {
    const { deps: d } = deps();
    const r = await runTenantRoutine({ run_id: "nope", emitted_tool_name: "tenant_skill__cto-engineer__abc12345" }, d);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/routine_run_not_found/);
  });

  it("does NOT find a routine scoped to a different agent (run agent_slug mismatch)", async () => {
    const { deps: d } = deps({ runAgent: "operator" });
    const r = await runTenantRoutine({ run_id: RUN_ID, emitted_tool_name: "tenant_skill__cto-engineer__abc12345" }, d);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/routine_not_found/);
  });
});

describe("runTenantRoutine — capability + recursion + budget guards", () => {
  it("FAILS the run when a step names a tool NOT in the granted set", async () => {
    const { deps: d, calls } = deps({
      routine: {
        id: "routine-1",
        tenant_id: TENANT_A,
        agent_slug: "cto-engineer",
        status: "approved",
        emitted_tool_name: "tenant_skill__cto-engineer__abc12345",
        routine_spec: { type: "tool_sequence", steps: [{ tool: "stripe__refund", args: {} }] },
        granted_tool_names: ["github__get_repo"],
        provenance_agent_def_hash: "h",
      },
      liveTools: ["github__get_repo", "stripe__refund"],
    });
    const r = await runTenantRoutine({ run_id: RUN_ID, emitted_tool_name: "tenant_skill__cto-engineer__abc12345" }, d);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/routine_tool_not_granted/);
    expect(calls).toHaveLength(0);
  });

  it("REJECTS a step that names another tenant_skill (no recursion)", async () => {
    const { deps: d } = deps({
      routine: {
        id: "routine-1",
        tenant_id: TENANT_A,
        agent_slug: "cto-engineer",
        status: "approved",
        emitted_tool_name: "tenant_skill__cto-engineer__abc12345",
        routine_spec: { type: "tool_sequence", steps: [{ tool: "tenant_skill__cto-engineer__deadbeef", args: {} }] },
        granted_tool_names: ["tenant_skill__cto-engineer__deadbeef"],
        provenance_agent_def_hash: "h",
      },
      liveTools: ["tenant_skill__cto-engineer__deadbeef"],
    });
    const r = await runTenantRoutine({ run_id: RUN_ID, emitted_tool_name: "tenant_skill__cto-engineer__abc12345" }, d);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/routine_recursion/);
  });

  it("FIX 12: a real tool whose tool-name SEGMENT contains 'tenant_skill' is NOT mis-flagged as recursion (parsed server_id, not substring)", async () => {
    const { deps: d, calls } = deps({
      routine: {
        id: "routine-1",
        tenant_id: TENANT_A,
        agent_slug: "cto-engineer",
        status: "approved",
        emitted_tool_name: "tenant_skill__cto-engineer__abc12345",
        routine_spec: { type: "tool_sequence", steps: [{ tool: "composio__tenant_skill_helper", args: {} }] },
        granted_tool_names: ["composio__tenant_skill_helper"],
        provenance_agent_def_hash: "h",
      },
      liveTools: ["composio__tenant_skill_helper"],
    });
    const r = await runTenantRoutine({ run_id: RUN_ID, emitted_tool_name: "tenant_skill__cto-engineer__abc12345" }, d);
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ server: "composio", tool: "tenant_skill_helper", idx: 0 }]);
  });

  it("STRIPS a granted tool the agent no longer has (re-intersection vs live)", async () => {
    const { deps: d, calls } = deps({
      routine: {
        id: "routine-1",
        tenant_id: TENANT_A,
        agent_slug: "cto-engineer",
        status: "approved",
        emitted_tool_name: "tenant_skill__cto-engineer__abc12345",
        routine_spec: { type: "tool_sequence", steps: [{ tool: "stripe__refund", args: {} }] },
        granted_tool_names: ["github__get_repo", "stripe__refund"],
        provenance_agent_def_hash: "hash-old",
      },
      liveTools: ["github__get_repo"],
    });
    const r = await runTenantRoutine({ run_id: RUN_ID, emitted_tool_name: "tenant_skill__cto-engineer__abc12345" }, d);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/routine_tool_not_granted/);
    expect(calls).toHaveLength(0);
  });

  it("enforces the hard step ceiling (fails closed on an over-long spec)", async () => {
    const steps = Array.from({ length: HARD_STEP_CEILING + 1 }, () => ({
      tool: "github__get_repo",
      args: {},
    }));
    const { deps: d } = deps({
      routine: {
        id: "routine-1",
        tenant_id: TENANT_A,
        agent_slug: "cto-engineer",
        status: "approved",
        emitted_tool_name: "tenant_skill__cto-engineer__abc12345",
        routine_spec: { type: "tool_sequence", steps },
        granted_tool_names: ["github__get_repo"],
        provenance_agent_def_hash: "h",
      },
    });
    const r = await runTenantRoutine({ run_id: RUN_ID, emitted_tool_name: "tenant_skill__cto-engineer__abc12345" }, d);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/routine_budget/);
  });

  it("aborts the sequence on a failing step (returns partial trace)", async () => {
    const callStep = vi.fn(async () => ({ is_error: true, content: "boom" }));
    const { deps: d } = deps({ callStep });
    const r = await runTenantRoutine({ run_id: RUN_ID, emitted_tool_name: "tenant_skill__cto-engineer__abc12345" }, d);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/routine_step_failed/);
  });
});

describe("runTenantRoutine — Move E4 trust-tier content-pin gate", () => {
  const EMITTED = "tenant_skill__cto-engineer__abc12345";
  const SPEC = {
    type: "tool_sequence",
    steps: [{ tool: "github__get_repo", args: { repo: "x" } }],
  };
  function routine(over: Record<string, unknown>) {
    return {
      id: "routine-1",
      tenant_id: TENANT_A,
      agent_slug: "cto-engineer",
      status: "approved",
      emitted_tool_name: EMITTED,
      routine_spec: SPEC,
      granted_tool_names: ["github__get_repo"],
      provenance_agent_def_hash: "h",
      ...over,
    };
  }

  it("BLOCKS an executable tenant_authored routine with NO content-pin (fail closed)", async () => {
    const { deps: d, calls } = deps({
      routine: routine({ provenance_origin: "tenant_authored", approved_spec_hash: null }),
    });
    const r = await runTenantRoutine({ run_id: RUN_ID, emitted_tool_name: EMITTED }, d);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/routine_unpinned/);
    expect(r.content).toMatch(/trust_level=scripts_executables/);
    expect(calls).toHaveLength(0);
  });

  it("CANNOT be bypassed by mislabeling: a smuggled trust_level='markdown_only' field is ignored — content-derived tier still gates it", async () => {
    const { deps: d, calls } = deps({
      routine: routine({
        provenance_origin: "tenant_authored",
        approved_spec_hash: null,
        trust_level: "markdown_only",
      }),
    });
    const r = await runTenantRoutine({ run_id: RUN_ID, emitted_tool_name: EMITTED }, d);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/routine_unpinned/);
    expect(calls).toHaveLength(0);
  });

  it("RUNS an executable tenant_authored routine once it carries the matching content-pin", async () => {
    const { deps: d, calls } = deps({
      routine: routine({
        provenance_origin: "tenant_authored",
        approved_spec_hash: hashValidatedRoutineSpec(SPEC),
      }),
    });
    const r = await runTenantRoutine({ run_id: RUN_ID, emitted_tool_name: EMITTED }, d);
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ server: "github", tool: "get_repo", idx: 0 }]);
  });

  it("STILL fails closed on a pin MISMATCH (directive mutated after approval)", async () => {
    const { deps: d, calls } = deps({
      routine: routine({
        provenance_origin: "tenant_authored",
        approved_spec_hash: "v1:deadbeef",
      }),
    });
    const r = await runTenantRoutine({ run_id: RUN_ID, emitted_tool_name: EMITTED }, d);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/routine_spec_tampered/);
    expect(calls).toHaveLength(0);
  });

  it("PRESERVES the legacy carve-out: a machine_distilled row with a NULL pin still runs (no regression)", async () => {
    const { deps: d, calls } = deps({
      routine: routine({ provenance_origin: "machine_distilled", approved_spec_hash: null }),
    });
    const r = await runTenantRoutine({ run_id: RUN_ID, emitted_tool_name: EMITTED }, d);
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ server: "github", tool: "get_repo", idx: 0 }]);
  });

  it("STRENGTHENED: an UNKNOWN provenance_origin with a NULL pin now fails closed (was silently allowed)", async () => {
    const { deps: d, calls } = deps({
      routine: routine({ provenance_origin: "smuggled_origin", approved_spec_hash: null }),
    });
    const r = await runTenantRoutine({ run_id: RUN_ID, emitted_tool_name: EMITTED }, d);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/routine_unpinned/);
    expect(calls).toHaveLength(0);
  });
});

describe("runTenantRoutine — D2 untrusted-inbound egress deny", () => {
  function egressRoutine() {
    return {
      id: "routine-1",
      tenant_id: TENANT_A,
      agent_slug: "operator",
      status: "approved",
      emitted_tool_name: "tenant_skill__operator__abc12345",
      routine_spec: { type: "tool_sequence", steps: [{ tool: "web_fetch__fetch", args: { url: "https://x" } }] },
      granted_tool_names: ["web_fetch__fetch"],
      provenance_agent_def_hash: "h",
    };
  }

  it("REJECTS a web_fetch step when the run is untrusted-inbound (email turn)", async () => {
    const { deps: d, calls } = deps({
      runAgent: "operator",
      routine: egressRoutine(),
      liveTools: ["web_fetch__fetch"],
    });
    const r = await runTenantRoutine(
      { run_id: RUN_ID, emitted_tool_name: "tenant_skill__operator__abc12345", untrusted_inbound: true },
      d,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/routine_policy_denied:egress_denied_untrusted_inbound/);
    expect(calls).toHaveLength(0);
  });

  it("ALLOWS the same web_fetch step on a normal (non-email) run with only baseline tools", async () => {
    const { deps: d, calls } = deps({
      runAgent: "operator",
      routine: egressRoutine(),
      liveTools: ["web_fetch__fetch"],
    });
    const r = await runTenantRoutine(
      { run_id: RUN_ID, emitted_tool_name: "tenant_skill__operator__abc12345"  },
      d,
    );
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ server: "web_fetch", tool: "fetch", idx: 0 }]);
  });
});

describe("runTenantRoutine — FIX 5 shared E-2 egress co-residency (general form, not just email)", () => {
  function coresidentEgressRoutine() {
    return {
      id: "routine-1",
      tenant_id: TENANT_A,
      agent_slug: "cto-engineer",
      status: "approved",
      emitted_tool_name: "tenant_skill__cto-engineer__abc12345",
      routine_spec: { type: "tool_sequence", steps: [{ tool: "web_fetch__fetch", args: { url: "https://x" } }] },
      granted_tool_names: ["web_fetch__fetch", "stripe__get_customer"],
      provenance_agent_def_hash: "h",
    };
  }

  it("ALLOWS a web_fetch step with a private-data tool co-resident (NON-email; E-2 block removed 2026-06-03)", async () => {
    const { deps: d, calls } = deps({
      routine: coresidentEgressRoutine(),
      liveTools: ["web_fetch__fetch", "stripe__get_customer"],
    });
    const r = await runTenantRoutine(
      { run_id: RUN_ID, emitted_tool_name: "tenant_skill__cto-engineer__abc12345"  },
      d,
    );
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("ALLOWS a web_fetch step on a research-scoped run even with the egress tool", async () => {
    const { deps: d } = deps({
      routine: coresidentEgressRoutine(),
      liveTools: ["web_fetch__fetch", "stripe__get_customer"],
    });
    d.loadLiveAgentDef = async () => ({
      tools: ["web_fetch__fetch", "stripe__get_customer"],
      def_hash: "h",
      output_envelope: "research_report",
    });
    const r = await runTenantRoutine(
      { run_id: RUN_ID, emitted_tool_name: "tenant_skill__cto-engineer__abc12345" },
      d,
    );
    expect(r.ok).toBe(true);
  });
});

describe("runTenantRoutine — FIX 15 egress uses RESOLVED tools, not raw declarations", () => {
  function webFetchRoutine() {
    return {
      id: "routine-1",
      tenant_id: TENANT_A,
      agent_slug: "cto-engineer",
      status: "approved",
      emitted_tool_name: "tenant_skill__cto-engineer__abc12345",
      routine_spec: { type: "tool_sequence", steps: [{ tool: "web_fetch__fetch", args: { url: "https://x" } }] },
      granted_tool_names: ["web_fetch__fetch"],
      provenance_agent_def_hash: "h",
    };
  }

  it("(b) ALLOWS web_fetch when the declared private connector is DISABLED (resolved = web-only) — no false co-residency", async () => {
    const { deps: d, calls } = deps({
      routine: webFetchRoutine(),
      liveTools: ["web_fetch__fetch", "stripe__get_customer"],
      resolvedTools: ["web_fetch__fetch"],
    });
    const r = await runTenantRoutine(
      { run_id: RUN_ID, emitted_tool_name: "tenant_skill__cto-engineer__abc12345" },
      d,
    );
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ server: "web_fetch", tool: "fetch", idx: 0 }]);
  });

  it("(c) ALLOWS web_fetch even when the private connector is ACTUALLY resolved (real co-residency; block removed 2026-06-03)", async () => {
    const { deps: d, calls } = deps({
      routine: webFetchRoutine(),
      liveTools: ["web_fetch__fetch", "stripe__get_customer"],
      resolvedTools: ["web_fetch__fetch", "stripe__get_customer"],
    });
    const r = await runTenantRoutine(
      { run_id: RUN_ID, emitted_tool_name: "tenant_skill__cto-engineer__abc12345" },
      d,
    );
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ server: "web_fetch", tool: "fetch", idx: 0 }]);
  });
});

describe("runTenantRoutine — FIX 18 self-presence exclusion (runner strips tenant_skill__* from co-residency)", () => {
  function webFetchRoutine() {
    return {
      id: "routine-1",
      tenant_id: TENANT_A,
      agent_slug: "cto-engineer",
      status: "approved",
      emitted_tool_name: "tenant_skill__cto-engineer__abc12345",
      routine_spec: { type: "tool_sequence", steps: [{ tool: "web_fetch__fetch", args: { url: "https://x" } }] },
      granted_tool_names: ["web_fetch__fetch"],
      provenance_agent_def_hash: "h",
    };
  }

  it("(a) ALLOWS a baseline-only web_fetch routine when ONLY its own (and sibling) tenant_skill__* tools are co-resident (self-presence not a false-deny)", async () => {
    const { deps: d, calls } = deps({
      routine: webFetchRoutine(),
      liveTools: ["web_fetch__fetch"],
      resolvedTools: [
        "web_fetch__fetch",
        "tenant_skill__cto-engineer__abc12345",
        "tenant_skill__cto-engineer__siblingff",
      ],
    });
    const r = await runTenantRoutine(
      { run_id: RUN_ID, emitted_tool_name: "tenant_skill__cto-engineer__abc12345" },
      d,
    );
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ server: "web_fetch", tool: "fetch", idx: 0 }]);
  });

  it("(b) ALLOWS even when a REAL private connector is co-resident alongside the routine tools (block removed 2026-06-03)", async () => {
    const { deps: d, calls } = deps({
      routine: webFetchRoutine(),
      liveTools: ["web_fetch__fetch"],
      resolvedTools: [
        "web_fetch__fetch",
        "tenant_skill__cto-engineer__abc12345",
        "stripe__get_customer",
      ],
    });
    const r = await runTenantRoutine(
      { run_id: RUN_ID, emitted_tool_name: "tenant_skill__cto-engineer__abc12345" },
      d,
    );
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ server: "web_fetch", tool: "fetch", idx: 0 }]);
  });
});

describe("runTenantRoutine — FIX 9 wildcard-aware grant re-intersection", () => {
  function composioRoutine() {
    return {
      id: "routine-1",
      tenant_id: TENANT_A,
      agent_slug: "operator",
      status: "approved",
      emitted_tool_name: "tenant_skill__operator__abc12345",
      routine_spec: { type: "tool_sequence", steps: [{ tool: "composio__search", args: { q: "x" } }] },
      granted_tool_names: ["composio__search"],
      provenance_agent_def_hash: "h",
    };
  }

  it("(a) EXECUTES a concrete composio__search step when the live def declares composio__* (wildcard grant)", async () => {
    const { deps: d, calls } = deps({
      runAgent: "operator",
      routine: composioRoutine(),
      liveTools: ["composio__*"],
    });
    const r = await runTenantRoutine(
      { run_id: RUN_ID, emitted_tool_name: "tenant_skill__operator__abc12345" },
      d,
    );
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ server: "composio", tool: "search", idx: 0 }]);
  });

  it("(b) STILL STRIPS composio__search when the live def has NO composio grant (fail-closed preserved)", async () => {
    const { deps: d, calls } = deps({
      runAgent: "operator",
      routine: composioRoutine(),
      liveTools: ["github__get_repo"],
    });
    const r = await runTenantRoutine(
      { run_id: RUN_ID, emitted_tool_name: "tenant_skill__operator__abc12345" },
      d,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/routine_tool_not_granted/);
    expect(calls).toHaveLength(0);
  });

  it("(c) EXACT-grant case still works unchanged (no wildcard)", async () => {
    const { deps: d, calls } = deps({
      runAgent: "operator",
      routine: composioRoutine(),
      liveTools: ["composio__search"],
    });
    const r = await runTenantRoutine(
      { run_id: RUN_ID, emitted_tool_name: "tenant_skill__operator__abc12345" },
      d,
    );
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ server: "composio", tool: "search", idx: 0 }]);
  });
});
