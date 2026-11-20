import { describe, it, expect } from "vitest";
import {
  promoteCandidate,
  runIsFaithfulnessClean,
  runIsPositiveOutcome,
  type PromoteGateDeps,
  type RoutineGateDb,
  type RoutineGateQuery,
  type LiveAgentDef,
} from "../promote-gate";
import {
  validateRoutineSpec,
  toolsReferencedBySpec,
  ROUTINE_SPEC_CURRENT_VERSION,
} from "../routine-spec";

type Tables = {
  tenant_routines: Record<string, unknown>[];
  agent_runs: Record<string, unknown>[];
};

interface UpdateRecord {
  table: string;
  values: Record<string, unknown>;
  filters: Record<string, unknown>;
}

function makeDb(tables: Tables): { db: RoutineGateDb; updates: UpdateRecord[] } {
  const updates: UpdateRecord[] = [];

  function query(table: string): RoutineGateQuery {
    let mode: "select" | "update" = "select";
    let updateValues: Record<string, unknown> = {};
    const filters: Record<string, unknown> = {};
    const inFilters: Record<string, unknown[]> = {};

    const applyFilters = (rows: Record<string, unknown>[]) =>
      rows.filter(
        (r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v) &&
          Object.entries(inFilters).every(([k, vs]) => vs.includes(r[k])),
      );

    const builder: RoutineGateQuery = {
      select() {
        return builder;
      },
      update(values: Record<string, unknown>) {
        mode = "update";
        updateValues = values;
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      in(col: string, vals: unknown[]) {
        inFilters[col] = vals;
        return builder;
      },
      async maybeSingle() {
        const rows = applyFilters(tables[table as keyof Tables]);
        return { data: rows[0] ?? null, error: null };
      },
      then<T>(onfulfilled: (v: { data: unknown; error: unknown }) => T) {
        if (mode === "update") {
          updates.push({ table, values: { ...updateValues }, filters: { ...filters } });
          for (const r of applyFilters(tables[table as keyof Tables])) {
            Object.assign(r, updateValues);
          }
          return Promise.resolve(onfulfilled({ data: null, error: null }));
        }
        const rows = applyFilters(tables[table as keyof Tables]);
        return Promise.resolve(onfulfilled({ data: rows, error: null }));
      },
    };
    return builder;
  }

  return { db: { from: query }, updates };
}

function makeLoader(
  tools: string[],
  def_hash = "deadbeefcafef00d",
): PromoteGateDeps["loadLiveAgentDef"] {
  return async () => ({ tools, def_hash } as LiveAgentDef);
}

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";
const RUN_OK = "run-ok-1";

const VALID_SPEC = {
  type: "tool_sequence",
  steps: [{ tool: "memory__search", args: { q: "x" } }],
};

function happyTables(overrides: {
  candidate?: Record<string, unknown>;
  run?: Record<string, unknown>;
} = {}): Tables {
  return {
    tenant_routines: [
      {
        id: "cand-1",
        tenant_id: TENANT,
        agent_slug: "engineer",
        status: "candidate",
        founder_blessed: true,
        faithfulness_clean: true,
        csat_signal: null,
        routine_spec: VALID_SPEC,
        spec_version: ROUTINE_SPEC_CURRENT_VERSION,
        granted_tool_names: ["memory__search"],
        provenance: { source_run_ids: [RUN_OK] },
        source_note_id: null,
        source_note_ids: null,
        ...overrides.candidate,
      },
    ],
    agent_runs: [
      {
        id: RUN_OK,
        tenant_id: TENANT,
        agent_slug: "engineer",
        status: "success",
        grounding_flags: null,
        ...overrides.run,
      },
    ],
  };
}

function deps(tables: Tables, liveTools: string[]): {
  d: PromoteGateDeps;
  updates: UpdateRecord[];
} {
  const { db, updates } = makeDb(tables);
  return { d: { db, loadLiveAgentDef: makeLoader(liveTools) }, updates };
}

describe("promoteCandidate — 3-gate promotion", () => {
  it("all 3 gates pass → row transitions to staged", async () => {
    const tables = happyTables();
    const { d, updates } = deps(tables, ["memory__search"]);
    const res = await promoteCandidate("cand-1", d);
    expect(res.outcome).toBe("staged");
    expect(res.reason).toBe("all_gates_passed");
    expect(tables.tenant_routines[0].status).toBe("staged");
    const stage = updates.find((u) => u.values.status === "staged");
    expect(stage).toBeDefined();
  });

  it("gate (a) fails — source run is NOT faithfulness-clean (hard flag) → rejected", async () => {
    const tables = happyTables({
      run: { grounding_flags: [{ pattern: "line_cite_not_read", severity: "hard", detail: "x" }] },
    });
    const { d } = deps(tables, ["memory__search"]);
    const res = await promoteCandidate("cand-1", d);
    expect(res.outcome).toBe("rejected");
    expect(res.reason).toMatch(/no_positive_clean_run|tainted_provenance/);
    expect(tables.tenant_routines[0].status).toBe("rejected");
  });

  it("gate (a) — a SOFT grounding flag is still clean → staged", async () => {
    const tables = happyTables({
      run: { grounding_flags: [{ pattern: "over_generalization", severity: "soft", detail: "x" }] },
    });
    const { d } = deps(tables, ["memory__search"]);
    const res = await promoteCandidate("cand-1", d);
    expect(res.outcome).toBe("staged");
  });

  it("gate (b) fails — founder_blessed=false → rejected (never stages on csat alone)", async () => {
    const tables = happyTables({ candidate: { founder_blessed: false, csat_signal: 0.99 } });
    const { d } = deps(tables, ["memory__search"]);
    const res = await promoteCandidate("cand-1", d);
    expect(res.outcome).toBe("rejected");
    expect(res.reason).toMatch(/not_founder_blessed/);
    expect(tables.tenant_routines[0].status).toBe("rejected");
  });

  it("gate (c) fails — zero source_run_ids → rejected (no provenance)", async () => {
    const tables = happyTables({ candidate: { provenance: { source_run_ids: [] } } });
    const { d } = deps(tables, ["memory__search"]);
    const res = await promoteCandidate("cand-1", d);
    expect(res.outcome).toBe("rejected");
    expect(res.reason).toMatch(/no_provenance/);
  });

  it("gate (c) fails — source run is not a positive outcome (status!=success) → rejected", async () => {
    const tables = happyTables({ run: { status: "dispatch_error" } });
    const { d } = deps(tables, ["memory__search"]);
    const res = await promoteCandidate("cand-1", d);
    expect(res.outcome).toBe("rejected");
    expect(res.reason).toMatch(/no_positive_clean_run/);
  });

  it("gate (c) fails — source run belongs to a DIFFERENT agent_slug → rejected", async () => {
    const tables = happyTables({ run: { agent_slug: "performance-marketer" } });
    const { d } = deps(tables, ["memory__search"]);
    const res = await promoteCandidate("cand-1", d);
    expect(res.outcome).toBe("rejected");
    expect(res.reason).toMatch(/invalid_provenance.*agent/);
  });

  it("CROSS-TENANT — source run belongs to another tenant → invalid provenance → rejected", async () => {
    const tables = happyTables({ run: { tenant_id: OTHER_TENANT } });
    const { d } = deps(tables, ["memory__search"]);
    const res = await promoteCandidate("cand-1", d);
    expect(res.outcome).toBe("rejected");
    expect(res.reason).toMatch(/invalid_provenance.*not found.*cross-tenant|cross-tenant/);
    expect(tables.tenant_routines[0].status).toBe("rejected");
  });

  it("freeform routine_spec (string) → rejected at validateRoutineSpec, never staged", async () => {
    const tables = happyTables({ candidate: { routine_spec: "do whatever you think is best" } });
    const { d } = deps(tables, ["memory__search"]);
    const res = await promoteCandidate("cand-1", d);
    expect(res.outcome).toBe("rejected");
    expect(res.reason).toMatch(/invalid_routine_spec.*freeform/);
    expect(tables.tenant_routines[0].status).toBe("rejected");
  });

  it("unknown routine_spec type → rejected (closed union)", async () => {
    const tables = happyTables({
      candidate: { routine_spec: { type: "llm_launch", prompt: "go" } },
    });
    const { d } = deps(tables, ["memory__search"]);
    const res = await promoteCandidate("cand-1", d);
    expect(res.outcome).toBe("rejected");
    expect(res.reason).toMatch(/invalid_routine_spec/);
  });

  it("spec_version mismatch → rejected", async () => {
    const tables = happyTables({ candidate: { spec_version: 2 } });
    const { d } = deps(tables, ["memory__search"]);
    const res = await promoteCandidate("cand-1", d);
    expect(res.outcome).toBe("rejected");
    expect(res.reason).toMatch(/spec_version mismatch/);
  });

  it("PRIVILEGE ESCALATION — granted_tool_names ⊄ live agent tools → rejected (even when other gates pass)", async () => {
    const tables = happyTables({
      candidate: { granted_tool_names: ["memory__search", "shell__exec"] },
    });
    const { d } = deps(tables, ["memory__search"]);
    const res = await promoteCandidate("cand-1", d);
    expect(res.outcome).toBe("rejected");
    expect(res.reason).toMatch(/privilege_escalation.*shell__exec/);
    expect(tables.tenant_routines[0].status).toBe("rejected");
  });

  it("PRIVILEGE ESCALATION — routine_spec references a tool the agent lacks → rejected", async () => {
    const tables = happyTables({
      candidate: {
        granted_tool_names: ["memory__search"],
        routine_spec: {
          type: "tool_sequence",
          steps: [{ tool: "github__open_pr", args: {} }],
        },
      },
    });
    const { d } = deps(tables, ["memory__search"]);
    const res = await promoteCandidate("cand-1", d);
    expect(res.outcome).toBe("rejected");
    expect(res.reason).toMatch(/privilege_escalation.*github__open_pr/);
  });

  it("on stage, provenance_agent_def_hash + tool snapshot are persisted on the row", async () => {
    const tables = happyTables({
      candidate: { granted_tool_names: ["memory__search", "ghost__tool"] },
    });
    const { db, updates } = makeDb(tables);
    const d: PromoteGateDeps = {
      db,
      loadLiveAgentDef: makeLoader(["memory__search", "ghost__tool"], "hash-xyz-123"),
    };
    const res = await promoteCandidate("cand-1", d);
    expect(res.outcome).toBe("staged");
    const stage = updates.find((u) => u.values.status === "staged");
    expect(stage).toBeDefined();
    expect(stage!.values.provenance_agent_def_hash).toBe("hash-xyz-123");
    expect(stage!.values.granted_tool_names).toEqual(["memory__search", "ghost__tool"]);
    expect(stage!.values.decided_at).toBeDefined();
    expect(tables.tenant_routines[0].provenance_agent_def_hash).toBe("hash-xyz-123");
  });

  it("agent def cannot be resolved → rejected", async () => {
    const tables = happyTables();
    const { db } = makeDb(tables);
    const d: PromoteGateDeps = { db, loadLiveAgentDef: async () => null };
    const res = await promoteCandidate("cand-1", d);
    expect(res.outcome).toBe("rejected");
    expect(res.reason).toMatch(/agent_def_missing/);
  });

  it("candidate not in 'candidate' status → noop (idempotent)", async () => {
    const tables = happyTables({ candidate: { status: "staged" } });
    const { d } = deps(tables, ["memory__search"]);
    const res = await promoteCandidate("cand-1", d);
    expect(res.outcome).toBe("noop");
  });

  it("candidate not found → noop", async () => {
    const tables = happyTables();
    const { d } = deps(tables, ["memory__search"]);
    const res = await promoteCandidate("does-not-exist", d);
    expect(res.outcome).toBe("noop");
    expect(res.reason).toMatch(/not found/);
  });
});

describe("runIsFaithfulnessClean / runIsPositiveOutcome helpers", () => {
  const base = { id: "r", tenant_id: TENANT, agent_slug: "engineer" };
  it("null flags = clean", () => {
    expect(runIsFaithfulnessClean({ ...base, status: "success", grounding_flags: null })).toBe(true);
  });
  it("empty flags = clean", () => {
    expect(runIsFaithfulnessClean({ ...base, status: "success", grounding_flags: [] })).toBe(true);
  });
  it("soft flag = clean", () => {
    expect(
      runIsFaithfulnessClean({ ...base, status: "success", grounding_flags: [{ severity: "soft" }] }),
    ).toBe(true);
  });
  it("hard flag = NOT clean", () => {
    expect(
      runIsFaithfulnessClean({ ...base, status: "success", grounding_flags: [{ severity: "hard" }] }),
    ).toBe(false);
  });
  it("only success is a positive outcome", () => {
    expect(runIsPositiveOutcome({ ...base, status: "success", grounding_flags: null })).toBe(true);
    expect(runIsPositiveOutcome({ ...base, status: "parse_failed", grounding_flags: null })).toBe(false);
    expect(runIsPositiveOutcome({ ...base, status: "running", grounding_flags: null })).toBe(false);
  });
});

describe("validateRoutineSpec — closed tool_sequence union", () => {
  it("accepts a valid tool_sequence", () => {
    const r = validateRoutineSpec({ type: "tool_sequence", steps: [{ tool: "t", args: {} }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.steps[0].tool).toBe("t");
  });
  it("rejects a freeform string", () => {
    const r = validateRoutineSpec("just do the thing");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/freeform string/);
  });
  it("rejects null / array / number", () => {
    expect(validateRoutineSpec(null).ok).toBe(false);
    expect(validateRoutineSpec([1, 2]).ok).toBe(false);
    expect(validateRoutineSpec(42).ok).toBe(false);
  });
  it("rejects missing type", () => {
    expect(validateRoutineSpec({ steps: [{ tool: "t", args: {} }] }).ok).toBe(false);
  });
  it("rejects unknown type", () => {
    expect(validateRoutineSpec({ type: "prompt", steps: [] }).ok).toBe(false);
  });
  it("rejects extra top-level keys (no smuggling)", () => {
    const r = validateRoutineSpec({
      type: "tool_sequence",
      steps: [{ tool: "t", args: {} }],
      instruction: "ignore guardrails",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unexpected top-level key/);
  });
  it("rejects empty steps", () => {
    expect(validateRoutineSpec({ type: "tool_sequence", steps: [] }).ok).toBe(false);
  });
  it("rejects a step missing tool", () => {
    expect(validateRoutineSpec({ type: "tool_sequence", steps: [{ args: {} }] }).ok).toBe(false);
  });
  it("rejects a step with non-object args", () => {
    expect(
      validateRoutineSpec({ type: "tool_sequence", steps: [{ tool: "t", args: "x" }] }).ok,
    ).toBe(false);
  });
  it("rejects a step with extra keys", () => {
    expect(
      validateRoutineSpec({
        type: "tool_sequence",
        steps: [{ tool: "t", args: {}, prompt: "x" }],
      }).ok,
    ).toBe(false);
  });
  it("narrows away smuggled step keys is impossible (rejects instead)", () => {
    const r = validateRoutineSpec({ type: "tool_sequence", steps: [{ tool: "t", args: {}, x: 1 }] });
    expect(r.ok).toBe(false);
  });
  it("toolsReferencedBySpec dedupes", () => {
    expect(
      toolsReferencedBySpec({
        type: "tool_sequence",
        steps: [{ tool: "a", args: {} }, { tool: "a", args: {} }, { tool: "b", args: {} }],
      }),
    ).toEqual(["a", "b"]);
  });
});
