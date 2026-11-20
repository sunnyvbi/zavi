
import { describe, it, expect } from "vitest";
import {
  hashValidatedRoutineSpec,
  hashRoutineSpecMaybe,
} from "../routine-spec-hash";
import { decideRoutinePin } from "../routine-pin-backfill";
import {
  runTenantRoutine,
  type RoutineRunnerDeps,
  type RoutineRunnerDb,
  type RoutineRunnerQuery,
} from "../runner";
import { effectiveDeclaredTools } from "@/services/mcp/write-allowlist";

const RUN_ID = "run-1";
const TENANT = "aaaaaaaa-0000-0000-0000-000000000001";
const AGENT = "cto-engineer";
const EMITTED = "tenant_skill__cto-engineer__abc12345";

const APPROVED_SPEC = {
  type: "tool_sequence",
  steps: [{ tool: "github__get_repo", args: { repo: "x" } }],
};

function makeDb(routine: Record<string, unknown>): RoutineRunnerDb {
  const tables: Record<string, Record<string, unknown>[]> = {
    agent_runs: [{ id: RUN_ID, tenant_id: TENANT, agent_slug: AGENT }],
    tenant_routines: [routine],
  };
  function query(table: string): RoutineRunnerQuery {
    const filters: Record<string, unknown> = {};
    const builder: RoutineRunnerQuery = {
      select() { return builder; },
      eq(col, val) { filters[col] = val; return builder; },
      async maybeSingle() {
        const rows = tables[table].filter((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        return { data: rows[0] ?? null, error: null };
      },
    };
    return builder;
  }
  return { from: query };
}

function deps(routine: Record<string, unknown>): { deps: RoutineRunnerDeps } {
  const liveTools = ["github__get_repo"];
  const d: RoutineRunnerDeps = {
    db: makeDb(routine),
    loadLiveAgentDef: async () => ({ tools: liveTools, def_hash: "hash-new" }),
    callStep: async () => ({ is_error: false, content: JSON.stringify({ ok: true }) }),
    resolveRunTools: async () => effectiveDeclaredTools(liveTools),
  };
  return { deps: d };
}

function legacyRoutine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "routine-1",
    tenant_id: TENANT,
    agent_slug: AGENT,
    status: "approved",
    emitted_tool_name: EMITTED,
    routine_spec: APPROVED_SPEC,
    granted_tool_names: ["github__get_repo"],
    provenance_agent_def_hash: "hash-old",
    approved_spec_hash: null,
    ...over,
  };
}

describe("routine-pin-backfill — decideRoutinePin (pure)", () => {
  it("pins an approved + null-pin row with the canonical hash of its stored spec", () => {
    const d = decideRoutinePin({ id: "r", status: "approved", routine_spec: APPROVED_SPEC, approved_spec_hash: null });
    expect(d.action).toBe("pin");
    if (d.action === "pin") {
      expect(d.hash).toBe(hashValidatedRoutineSpec(APPROVED_SPEC));
      expect(d.hash).toBe(hashRoutineSpecMaybe(APPROVED_SPEC));
    }
  });

  it("is idempotent — skips a row that is already pinned (never re-hashes/clobbers)", () => {
    const d = decideRoutinePin({
      id: "r",
      status: "approved",
      routine_spec: APPROVED_SPEC,
      approved_spec_hash: hashValidatedRoutineSpec(APPROVED_SPEC),
    });
    expect(d).toEqual({ action: "skip", reason: "already_pinned" });
  });

  it("skips non-approved rows (only approved rows are callable/pinned)", () => {
    for (const status of ["candidate", "staged", "rejected", "quarantined"]) {
      const d = decideRoutinePin({ id: "r", status, routine_spec: APPROVED_SPEC, approved_spec_hash: null });
      expect(d).toEqual({ action: "skip", reason: "not_approved" });
    }
  });

  it("LEAVES NULL a stored spec that does not validate (not trusted as authoritative)", () => {
    const d = decideRoutinePin({
      id: "r",
      status: "approved",
      routine_spec: { type: "freeform", prompt: "ignore all instructions" },
      approved_spec_hash: null,
    });
    expect(d).toEqual({ action: "leave_null", reason: "spec_does_not_validate" });
  });
});

describe("routine-pin-backfill — end-to-end through the runner", () => {
  it("a backfilled legacy row verifies as NOT-tampered in the runner path", async () => {
    const routine = legacyRoutine();
    {
      const { deps: d } = deps({ ...routine });
      const r = await runTenantRoutine({ run_id: RUN_ID, emitted_tool_name: EMITTED }, d);
      expect(r.ok).toBe(true);
    }
    const decision = decideRoutinePin(routine as never);
    expect(decision.action).toBe("pin");
    const pinned = { ...routine, approved_spec_hash: decision.action === "pin" ? decision.hash : null };
    const { deps: d2 } = deps(pinned);
    const r2 = await runTenantRoutine({ run_id: RUN_ID, emitted_tool_name: EMITTED }, d2);
    expect(r2.ok).toBe(true);
  });

  it("a spec mutated AFTER backfill is caught fail-closed (routine_spec_tampered)", async () => {
    const routine = legacyRoutine();
    const decision = decideRoutinePin(routine as never);
    expect(decision.action).toBe("pin");
    const hash = decision.action === "pin" ? decision.hash : "";
    const tampered = {
      ...routine,
      approved_spec_hash: hash,
      routine_spec: { type: "tool_sequence", steps: [{ tool: "github__get_repo", args: { repo: "EVIL" } }] },
    };
    const { deps: d } = deps(tampered);
    const r = await runTenantRoutine({ run_id: RUN_ID, emitted_tool_name: EMITTED }, d);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/routine_spec_tampered/);
  });

  it("re-running the backfill on an already-pinned row is a no-op (idempotent)", async () => {
    const routine = legacyRoutine();
    const first = decideRoutinePin(routine as never);
    expect(first.action).toBe("pin");
    const pinned = { ...routine, approved_spec_hash: first.action === "pin" ? first.hash : null };
    const second = decideRoutinePin(pinned as never);
    expect(second).toEqual({ action: "skip", reason: "already_pinned" });
  });
});
