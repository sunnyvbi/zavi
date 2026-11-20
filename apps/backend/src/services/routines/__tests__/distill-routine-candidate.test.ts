import { describe, it, expect } from "vitest";
import {
  distillRoutineCandidates,
  extractRoutableSequence,
  isFaithfulnessClean,
  signatureForSequence,
  distillRoutineEnabled,
  DISTILL_ROUTINE_ENV_FLAG,
  MIN_OCCURRENCES,
  type DistillRoutineDeps,
  type DistillRunRow,
  type CandidateInsert,
} from "../distill-routine-candidate";
import { validateRoutineSpec, ROUTINE_SPEC_CURRENT_VERSION } from "../routine-spec";
import {
  promoteCandidate,
  type PromoteGateDeps,
  type RoutineGateDb,
  type RoutineGateQuery,
  type LiveAgentDef,
} from "../promote-gate";

const FLAG_ON: NodeJS.ProcessEnv = { [DISTILL_ROUTINE_ENV_FLAG]: "1" } as NodeJS.ProcessEnv;
const FLAG_OFF: NodeJS.ProcessEnv = { [DISTILL_ROUTINE_ENV_FLAG]: "0" } as NodeJS.ProcessEnv;

const SEQ = ["slack__post_message", "github__create_issue"];

function run(
  id: string,
  opts: Partial<DistillRunRow> & { seq?: string[] } = {},
): DistillRunRow {
  const seq = opts.seq ?? SEQ;
  return {
    id,
    tenant_id: opts.tenant_id ?? "tenantA",
    agent_slug: opts.agent_slug ?? "engineer",
    status: opts.status ?? "success",
    grounding_flags: opts.grounding_flags ?? null,
    tool_calls:
      opts.tool_calls ?? seq.map((name) => ({ name, status: "ok" as const })),
  };
}

interface Harness {
  deps: DistillRoutineDeps;
  inserted: CandidateInsert[];
  signatureExistsCalls: number;
}

function makeDeps(
  runs: DistillRunRow[],
  opts: {
    env?: NodeJS.ProcessEnv;
    existingSignatures?: Set<string>;
    insertThrows?: boolean;
  } = {},
): Harness {
  const inserted: CandidateInsert[] = [];
  const existing = opts.existingSignatures ?? new Set<string>();
  const h: Harness = {
    inserted,
    signatureExistsCalls: 0,
    deps: {
      env: opts.env ?? FLAG_ON,
      now: () => new Date("2026-06-29T00:00:00Z"),
      readSuccessfulRuns: async () => runs,
      signatureExists: async (_t, _a, sig) => {
        h.signatureExistsCalls += 1;
        return existing.has(sig);
      },
      insertCandidate: async (row) => {
        if (opts.insertThrows) throw new Error("simulated insert failure");
        inserted.push(row);
      },
      logger: { warn: () => {} },
    },
  };
  return h;
}

describe("extractRoutableSequence", () => {
  it("keeps only succeeded, routable tool names, in order", () => {
    const seq = extractRoutableSequence([
      { name: "slack__post_message", status: "ok" },
      { name: "memory_search", status: "ok" },
      { name: "github__create_issue", status: "tool_error" },
      { name: "stripe__create_refund", status: "ok" },
      { name: "tenant_skill__engineer__abc12345", status: "ok" },
    ]);
    expect(seq).toEqual(["slack__post_message", "stripe__create_refund"]);
  });

  it("returns [] for null / empty", () => {
    expect(extractRoutableSequence(null)).toEqual([]);
    expect(extractRoutableSequence([])).toEqual([]);
  });
});

describe("isFaithfulnessClean", () => {
  it("clean when no flags or no hard flag; tainted on a hard flag", () => {
    expect(isFaithfulnessClean(null)).toBe(true);
    expect(isFaithfulnessClean([{ severity: "soft" }])).toBe(true);
    expect(isFaithfulnessClean([{ severity: "hard" }])).toBe(false);
  });
});

describe("distillRoutineEnabled — DEFAULT-ON kill switch", () => {
  it("is ON when the env var is unset (the default) or explicitly '1'", () => {
    expect(distillRoutineEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(distillRoutineEnabled(FLAG_ON)).toBe(true);
  });
  it("is OFF only when explicitly set to '0' (the kill switch)", () => {
    expect(distillRoutineEnabled(FLAG_OFF)).toBe(false);
  });
});

describe("distillRoutineCandidates", () => {
  it("stages ONE candidate when the same procedure recurs N≥3 (not approved/executable)", async () => {
    const h = makeDeps([run("r1"), run("r2"), run("r3")]);
    const stats = await distillRoutineCandidates(h.deps);

    expect(stats.enabled).toBe(true);
    expect(stats.candidates_staged).toBe(1);
    expect(h.inserted).toHaveLength(1);

    const c = h.inserted[0];
    expect(c.status).toBe("candidate");
    expect(c.founder_blessed).toBe(false);
    expect(c.faithfulness_clean).toBe(true);
    expect((c as unknown as Record<string, unknown>).emitted_tool_name).toBeUndefined();
    expect((c as unknown as Record<string, unknown>).approved_spec_hash).toBeUndefined();

    const v = validateRoutineSpec(c.routine_spec);
    expect(v.ok).toBe(true);
    expect(c.spec_version).toBe(ROUTINE_SPEC_CURRENT_VERSION);
    expect(c.routine_spec.steps.map((s) => s.tool)).toEqual(SEQ);
    expect(c.routine_spec.steps.every((s) => Object.keys(s.args).length === 0)).toBe(true);
    expect(c.granted_tool_names.sort()).toEqual([...SEQ].sort());

    expect(c.provenance.source_run_ids).toEqual(["r1", "r2", "r3"]);
    expect(c.provenance.kind).toBe("auto_distill_trajectory");
    expect(c.provenance.distill_signature).toBe(signatureForSequence(SEQ));

    const blob = JSON.stringify(c);
    expect(blob).not.toContain("input_preview");
  });

  it("does NOT stage when occurrences < N (only 2 of the same procedure)", async () => {
    const h = makeDeps([run("r1"), run("r2")]);
    const stats = await distillRoutineCandidates(h.deps);
    expect(MIN_OCCURRENCES).toBe(3);
    expect(stats.candidates_staged).toBe(0);
    expect(h.inserted).toHaveLength(0);
  });

  it("flag OFF → total no-op (nothing scanned, nothing staged)", async () => {
    const h = makeDeps([run("r1"), run("r2"), run("r3")], { env: FLAG_OFF });
    const stats = await distillRoutineCandidates(h.deps);
    expect(stats.enabled).toBe(false);
    expect(stats.runs_scanned).toBe(0);
    expect(stats.candidates_staged).toBe(0);
    expect(h.inserted).toHaveLength(0);
    expect(h.signatureExistsCalls).toBe(0);
  });

  it("excludes faithfulness-tainted runs from the count (2 clean + 1 hard-flag → no stage)", async () => {
    const h = makeDeps([
      run("r1"),
      run("r2"),
      run("r3", { grounding_flags: [{ severity: "hard" }] }),
    ]);
    const stats = await distillRoutineCandidates(h.deps);
    expect(stats.faithfulness_clean_runs).toBe(2);
    expect(stats.candidates_staged).toBe(0);
    expect(h.inserted).toHaveLength(0);
  });

  it("idempotence — skips a procedure whose signature already exists (any status)", async () => {
    const sig = signatureForSequence(SEQ);
    const h = makeDeps([run("r1"), run("r2"), run("r3")], {
      existingSignatures: new Set([sig]),
    });
    const stats = await distillRoutineCandidates(h.deps);
    expect(stats.skipped_existing).toBe(1);
    expect(stats.candidates_staged).toBe(0);
    expect(h.inserted).toHaveLength(0);
  });

  it("does NOT stage when the sequence has < 2 routable steps", async () => {
    const oneStep = [
      { name: "slack__post_message", status: "ok" as const },
      { name: "memory_search", status: "ok" as const },
    ];
    const h = makeDeps([
      run("r1", { tool_calls: oneStep }),
      run("r2", { tool_calls: oneStep }),
      run("r3", { tool_calls: oneStep }),
    ]);
    const stats = await distillRoutineCandidates(h.deps);
    expect(stats.candidates_staged).toBe(0);
  });

  it("isolates by tenant + agent (same sequence across tenants does not merge)", async () => {
    const h = makeDeps([
      run("a1", { tenant_id: "tenantA" }),
      run("a2", { tenant_id: "tenantA" }),
      run("b1", { tenant_id: "tenantB" }),
      run("b2", { tenant_id: "tenantB" }),
      run("b3", { tenant_id: "tenantB" }),
    ]);
    const stats = await distillRoutineCandidates(h.deps);
    expect(stats.candidates_staged).toBe(1);
    expect(h.inserted[0].tenant_id).toBe("tenantB");
    expect(h.inserted[0].provenance.source_run_ids).toEqual(["b1", "b2", "b3"]);
  });

  it("insert failure is counted, never thrown", async () => {
    const h = makeDeps([run("r1"), run("r2"), run("r3")], { insertThrows: true });
    const stats = await distillRoutineCandidates(h.deps);
    expect(stats.candidates_staged).toBe(0);
    expect(stats.insert_failures).toBe(1);
  });
});

function makePromoteDb(
  candidate: Record<string, unknown>,
  runs: Record<string, unknown>[],
): { db: RoutineGateDb; finalStatus: () => string } {
  function query(table: string): RoutineGateQuery {
    let mode: "select" | "update" = "select";
    let updateValues: Record<string, unknown> = {};
    const filters: Record<string, unknown> = {};
    const inFilters: Record<string, unknown[]> = {};
    const rowsFor = () => (table === "tenant_routines" ? [candidate] : runs);
    const apply = (rows: Record<string, unknown>[]) =>
      rows.filter(
        (r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v) &&
          Object.entries(inFilters).every(([k, vs]) => vs.includes(r[k])),
      );
    const builder: RoutineGateQuery = {
      select() {
        return builder;
      },
      update(v) {
        mode = "update";
        updateValues = v;
        return builder;
      },
      eq(col, val) {
        filters[col] = val;
        return builder;
      },
      in(col, vals) {
        inFilters[col] = vals;
        return builder;
      },
      async maybeSingle() {
        return { data: apply(rowsFor())[0] ?? null, error: null };
      },
      then<T>(onfulfilled: (v: { data: unknown; error: unknown }) => T) {
        if (mode === "update") {
          for (const r of apply(rowsFor())) Object.assign(r, updateValues);
          return Promise.resolve(onfulfilled({ data: null, error: null }));
        }
        return Promise.resolve(onfulfilled({ data: apply(rowsFor()), error: null }));
      },
    };
    return builder;
  }
  return {
    db: { from: query },
    finalStatus: () => String(candidate.status),
  };
}

function promoteDeps(db: RoutineGateDb): PromoteGateDeps {
  return {
    db,
    loadLiveAgentDef: async (): Promise<LiveAgentDef> => ({
      tools: [...SEQ],
      def_hash: "def_hash_v1",
    }),
  };
}

describe("distilled candidate flows through the UNCHANGED promote-gate", () => {
  async function stageOne(): Promise<CandidateInsert> {
    const h = makeDeps([run("r1"), run("r2"), run("r3")]);
    await distillRoutineCandidates(h.deps);
    return h.inserted[0];
  }

  it("CANNOT promote while founder_blessed=false (operator stays in the loop)", async () => {
    const c = await stageOne();
    const row = { id: "cand1", ...c };
    const runs = ["r1", "r2", "r3"].map((id) => ({
      id,
      tenant_id: "tenantA",
      agent_slug: "engineer",
      status: "success",
      grounding_flags: null,
    }));
    const { db, finalStatus } = makePromoteDb(row, runs);
    const res = await promoteCandidate("cand1", promoteDeps(db));
    expect(res.outcome).toBe("rejected");
    expect(res.reason).toContain("not_founder_blessed");
    expect(finalStatus()).toBe("rejected");
  });

  it("promotes to 'staged' ONLY once a founder has blessed it", async () => {
    const c = await stageOne();
    const row = { id: "cand2", ...c, founder_blessed: true };
    const runs = ["r1", "r2", "r3"].map((id) => ({
      id,
      tenant_id: "tenantA",
      agent_slug: "engineer",
      status: "success",
      grounding_flags: null,
    }));
    const { db, finalStatus } = makePromoteDb(row, runs);
    const res = await promoteCandidate("cand2", promoteDeps(db));
    expect(res.outcome).toBe("staged");
    expect(finalStatus()).toBe("staged");
  });
});
