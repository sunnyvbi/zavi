
import { describe, it, expect } from "vitest";
import {
  distillSkillCandidates,
  signatureForSequence,
  deterministicSkillProse,
  MIN_OCCURRENCES,
  MAX_SYNTH_WRITE_ATTEMPTS_PER_PASS,
  type DistillSkillDeps,
  type SkillNoteWrite,
  type SkillCluster,
} from "../distill-skill-candidate";
import type { DistillRunRow } from "@/services/routines/distill-routine-candidate";

const SEQ = ["slack__post_message", "github__create_issue"];

function run(id: string, opts: Partial<DistillRunRow> & { seq?: string[] } = {}): DistillRunRow {
  const seq = opts.seq ?? SEQ;
  return {
    id,
    tenant_id: opts.tenant_id ?? "tenantA",
    agent_slug: opts.agent_slug ?? "engineer",
    status: opts.status ?? "success",
    grounding_flags: opts.grounding_flags ?? null,
    tool_calls: opts.tool_calls ?? seq.map((name) => ({ name, status: "ok" as const })),
  };
}

interface Harness {
  deps: DistillSkillDeps;
  written: SkillNoteWrite[];
  existenceChecks: number;
  scanCalls: number;
  scanTenantScope: string[] | null;
  synthCalls: number;
}

function makeDeps(
  runs: DistillRunRow[],
  opts: {
    enabledTenants?: Set<string>;
    existingRefs?: Set<string>;
    writeThrows?: boolean;
    synthesizeProse?: DistillSkillDeps["synthesizeProse"];
  } = {},
): Harness {
  const written: SkillNoteWrite[] = [];
  const enabled = opts.enabledTenants ?? new Set<string>();
  const existing = opts.existingRefs ?? new Set<string>();
  const h: Harness = {
    written,
    existenceChecks: 0,
    scanCalls: 0,
    scanTenantScope: null,
    synthCalls: 0,
    deps: {
      enabledTenantIds: async () => Array.from(enabled),
      readSuccessfulRuns: async (_since, _limit, tenantIds) => {
        h.scanCalls += 1;
        h.scanTenantScope = tenantIds;
        const scope = new Set(tenantIds);
        return runs.filter((r) => scope.has(r.tenant_id));
      },
      skillSourceRefExists: async (t, ref) => {
        h.existenceChecks += 1;
        return existing.has(`${t}::${ref}`);
      },
      synthesizeProse: opts.synthesizeProse
        ? async (c) => {
            h.synthCalls += 1;
            return opts.synthesizeProse!(c);
          }
        : undefined,
      writeSkillNote: async (note) => {
        if (opts.writeThrows) throw new Error("boom");
        written.push(note);
      },
      logger: { warn: () => {} },
    },
  };
  return h;
}

const N = MIN_OCCURRENCES;

describe("distill-skill-candidate (GAP #4 v1 step 3)", () => {
  it("flag OFF (no tenant enabled) → ZERO scan/synth/write work (SAFE-INERT)", async () => {
    const runs = Array.from({ length: N }, (_, i) => run(`r${i}`));
    const h = makeDeps(runs, { enabledTenants: new Set() });
    const stats = await distillSkillCandidates(h.deps);

    expect(h.written).toHaveLength(0);
    expect(stats.skills_written).toBe(0);
    expect(stats.enabled_tenants).toBe(0);
    expect(h.scanCalls).toBe(0);
    expect(stats.runs_scanned).toBe(0);
    expect(h.existenceChecks).toBe(0);
  });

  it("flag ON: the agent_runs scan is SCOPED to exactly the opted-in tenants", async () => {
    const runs = Array.from({ length: N }, (_, i) => run(`r${i}`));
    const h = makeDeps(runs, { enabledTenants: new Set(["tenantA"]) });
    await distillSkillCandidates(h.deps);
    expect(h.scanCalls).toBe(1);
    expect(h.scanTenantScope).toEqual(["tenantA"]);
  });

  it("flag ON + a qualifying cluster → EXACTLY ONE skill note, with the skill shape", async () => {
    const runs = Array.from({ length: N }, (_, i) => run(`r${i}`));
    const h = makeDeps(runs, { enabledTenants: new Set(["tenantA"]) });
    const stats = await distillSkillCandidates(h.deps);

    expect(stats.skills_written).toBe(1);
    expect(h.written).toHaveLength(1);
    const note = h.written[0];
    expect(note.tenant_id).toBe("tenantA");
    expect(note.source_ref).toBe(`skill_distill:${signatureForSequence(SEQ)}`);
    expect(note.metadata.kind).toBe("auto_distill_skill");
    expect(note.metadata.occurrence_count).toBe(N);
    expect(note.metadata.agent_slugs).toEqual(["engineer"]);
    expect(note.title.length).toBeGreaterThan(0);
    expect(note.body_markdown.length).toBeGreaterThan(0);
  });

  it("below the recurrence threshold → no note (a one-off is not a skill)", async () => {
    const runs = Array.from({ length: N - 1 }, (_, i) => run(`r${i}`));
    const h = makeDeps(runs, { enabledTenants: new Set(["tenantA"]) });
    const stats = await distillSkillCandidates(h.deps);
    expect(stats.skills_written).toBe(0);
    expect(h.written).toHaveLength(0);
  });

  it("idempotent: a cluster whose source_ref already exists writes NO duplicate", async () => {
    const runs = Array.from({ length: N }, (_, i) => run(`r${i}`));
    const ref = `skill_distill:${signatureForSequence(SEQ)}`;
    const h = makeDeps(runs, {
      enabledTenants: new Set(["tenantA"]),
      existingRefs: new Set([`tenantA::${ref}`]),
    });
    const stats = await distillSkillCandidates(h.deps);

    expect(stats.skills_written).toBe(0);
    expect(stats.skipped_existing).toBe(1);
    expect(h.written).toHaveLength(0);
  });

  it("re-run after a write (same input) is idempotent via source_ref", async () => {
    const runs = Array.from({ length: N }, (_, i) => run(`r${i}`));
    const seen = new Set<string>();
    const written: SkillNoteWrite[] = [];
    const deps: DistillSkillDeps = {
      enabledTenantIds: async () => ["tenantA"],
      readSuccessfulRuns: async (_s, _l, tenantIds) =>
        runs.filter((r) => tenantIds.includes(r.tenant_id)),
      skillSourceRefExists: async (t, ref) => seen.has(`${t}::${ref}`),
      writeSkillNote: async (note) => {
        seen.add(`${note.tenant_id}::${note.source_ref}`);
        written.push(note);
      },
      logger: { warn: () => {} },
    };

    const s1 = await distillSkillCandidates(deps);
    const s2 = await distillSkillCandidates(deps);
    expect(s1.skills_written).toBe(1);
    expect(s2.skills_written).toBe(0);
    expect(s2.skipped_existing).toBe(1);
    expect(written).toHaveLength(1);
  });

  it("clusters CROSS-AGENT: the same procedure run by different agents collapses to one skill", async () => {
    const runs = [
      run("r0", { agent_slug: "engineer" }),
      run("r1", { agent_slug: "support-lead" }),
      run("r2", { agent_slug: "operator" }),
    ];
    const h = makeDeps(runs, { enabledTenants: new Set(["tenantA"]) });
    const stats = await distillSkillCandidates(h.deps);
    expect(stats.skills_written).toBe(1);
    expect(h.written[0].metadata.agent_slugs).toEqual(["engineer", "operator", "support-lead"]);
  });

  it("faithfulness-tainted runs do not contribute to a cluster", async () => {
    const tainted = { grounding_flags: [{ severity: "hard" }] };
    const runs = Array.from({ length: N }, (_, i) => run(`r${i}`, tainted));
    const h = makeDeps(runs, { enabledTenants: new Set(["tenantA"]) });
    const stats = await distillSkillCandidates(h.deps);
    expect(stats.skills_written).toBe(0);
    expect(h.written).toHaveLength(0);
  });

  it("uses the deterministic fallback when the LLM synthesizer throws", async () => {
    const runs = Array.from({ length: N }, (_, i) => run(`r${i}`));
    const h = makeDeps(runs, {
      enabledTenants: new Set(["tenantA"]),
      synthesizeProse: async () => {
        throw new Error("LLM down");
      },
    });
    const stats = await distillSkillCandidates(h.deps);
    expect(stats.skills_written).toBe(1);
    expect(h.written[0].body_markdown.length).toBeGreaterThan(0);
  });

  it("prefers the LLM synthesizer output when it returns non-empty prose", async () => {
    const runs = Array.from({ length: N }, (_, i) => run(`r${i}`));
    const h = makeDeps(runs, {
      enabledTenants: new Set(["tenantA"]),
      synthesizeProse: async (c: SkillCluster) => ({
        title: `LLM title for ${c.sequence.length} steps`,
        body_markdown: "LLM-written skill body.",
      }),
    });
    await distillSkillCandidates(h.deps);
    expect(h.written[0].body_markdown).toBe("LLM-written skill body.");
    expect(h.written[0].title).toContain("LLM title");
  });

  it("multi-tenant: only the enabled tenant gets a skill", async () => {
    const runs = [
      ...Array.from({ length: N }, (_, i) => run(`a${i}`, { tenant_id: "tenantA" })),
      ...Array.from({ length: N }, (_, i) => run(`b${i}`, { tenant_id: "tenantB" })),
    ];
    const h = makeDeps(runs, { enabledTenants: new Set(["tenantA"]) });
    const stats = await distillSkillCandidates(h.deps);
    expect(stats.skills_written).toBe(1);
    expect(h.written.map((w) => w.tenant_id)).toEqual(["tenantA"]);
  });

  it("COST CAP: synth+write attempts are bounded per pass EVEN when every write FAILS", async () => {
    const total = MAX_SYNTH_WRITE_ATTEMPTS_PER_PASS + 5;
    const runs: DistillRunRow[] = [];
    for (let cl = 0; cl < total; cl++) {
      const seq = [`svc${cl}__step_a`, `svc${cl}__step_b`];
      for (let i = 0; i < N; i++) runs.push(run(`c${cl}_r${i}`, { seq }));
    }
    const h = makeDeps(runs, {
      enabledTenants: new Set(["tenantA"]),
      writeThrows: true,
      synthesizeProse: async (c) => ({ title: "t", body_markdown: `b ${c.signature}` }),
    });
    const stats = await distillSkillCandidates(h.deps);

    expect(stats.skills_written).toBe(0);
    expect(stats.synth_write_attempts).toBe(MAX_SYNTH_WRITE_ATTEMPTS_PER_PASS);
    expect(h.synthCalls).toBe(MAX_SYNTH_WRITE_ATTEMPTS_PER_PASS);
    expect(stats.write_failures).toBe(MAX_SYNTH_WRITE_ATTEMPTS_PER_PASS);
  });

  it("existing-skill skips are cheap (do NOT consume the synth cost cap)", async () => {
    const total = MAX_SYNTH_WRITE_ATTEMPTS_PER_PASS + 5;
    const runs: DistillRunRow[] = [];
    const existingRefs = new Set<string>();
    for (let cl = 0; cl < total; cl++) {
      const seq = [`svc${cl}__step_a`, `svc${cl}__step_b`];
      for (let i = 0; i < N; i++) runs.push(run(`c${cl}_r${i}`, { seq }));
      existingRefs.add(`tenantA::skill_distill:${signatureForSequence(seq)}`);
    }
    const h = makeDeps(runs, { enabledTenants: new Set(["tenantA"]), existingRefs });
    const stats = await distillSkillCandidates(h.deps);

    expect(stats.skipped_existing).toBe(total);
    expect(stats.synth_write_attempts).toBe(0);
    expect(stats.skills_written).toBe(0);
  });

  it("C14: the distiller uses only tool name+status (a name-only run still clusters)", async () => {
    const runs = Array.from({ length: N }, (_, i) =>
      run(`r${i}`, {
        tool_calls: SEQ.map((name) => ({ name, status: "ok" as const })),
      }),
    );
    const h = makeDeps(runs, { enabledTenants: new Set(["tenantA"]) });
    const stats = await distillSkillCandidates(h.deps);
    expect(stats.skills_written).toBe(1);
  });

  it("deterministicSkillProse derives only tool names + counts (no raw content)", () => {
    const cluster: SkillCluster = {
      tenant_id: "tenantA",
      agent_slugs: ["engineer"],
      sequence: SEQ,
      signature: signatureForSequence(SEQ),
      run_ids: ["r0", "r1", "r2"],
      occurrences: 3,
    };
    const prose = deterministicSkillProse(cluster);
    expect(prose.body_markdown).toContain("slack__post_message");
    expect(prose.title.length).toBeGreaterThan(0);
  });
});
