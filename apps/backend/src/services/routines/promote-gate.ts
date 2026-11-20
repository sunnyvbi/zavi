
import { serviceClient } from "@/services/supabase";
import { loadAgentDefinition } from "@/services/agents/registry";
import {
  validateRoutineSpec,
  toolsReferencedBySpec,
  ROUTINE_SPEC_CURRENT_VERSION,
  type RoutineSpecV1,
} from "./routine-spec";
import { makeLiveToolMatcher } from "@/services/mcp/declared-tool-match";
import { isRoutableRoutineStepTool } from "./tool-name";

export interface RoutineGateDb {
  from(table: string): RoutineGateQuery;
}
export interface RoutineGateQuery {
  select(cols: string): RoutineGateQuery;
  update(values: Record<string, unknown>): RoutineGateQuery;
  eq(col: string, val: unknown): RoutineGateQuery;
  in(col: string, vals: unknown[]): RoutineGateQuery;
  maybeSingle(): Promise<{ data: unknown; error: unknown }>;
  then<T>(onfulfilled: (v: { data: unknown; error: unknown }) => T): Promise<T>;
}

export interface LiveAgentDef {
  tools: string[];
  def_hash: string;
}

export type AgentDefLoader = (
  agent_slug: string,
  tenant_id: string,
) => Promise<LiveAgentDef | null>;

export interface PromoteGateDeps {
  db: RoutineGateDb;
  loadLiveAgentDef: AgentDefLoader;
}

interface CandidateRow {
  id: string;
  tenant_id: string;
  agent_slug: string;
  status: string;
  founder_blessed: boolean | null;
  faithfulness_clean: boolean | null;
  csat_signal: number | null;
  routine_spec: unknown;
  spec_version: number | null;
  granted_tool_names: string[] | null;
  provenance: { source_run_ids?: unknown } | null;
  source_note_id: string | null;
  source_note_ids: string[] | null;
  provenance_origin: string | null;
}

interface AgentRunRow {
  id: string;
  tenant_id: string;
  agent_slug: string;
  status: string;
  grounding_flags: Array<{ severity?: string }> | null;
}

export type PromoteOutcome = "staged" | "rejected" | "noop";

export interface PromoteResult {
  candidate_id: string;
  outcome: PromoteOutcome;
  reason: string;
}

const CANDIDATE_COLS =
  "id, tenant_id, agent_slug, status, founder_blessed, faithfulness_clean, " +
  "csat_signal, routine_spec, spec_version, granted_tool_names, provenance, " +
  "source_note_id, source_note_ids, provenance_origin";

export function runIsFaithfulnessClean(run: AgentRunRow): boolean {
  const flags = run.grounding_flags;
  if (!flags || flags.length === 0) return true;
  return !flags.some((f) => f?.severity === "hard");
}

export function runIsPositiveOutcome(run: AgentRunRow): boolean {
  return run.status === "success";
}

function readSourceRunIds(c: CandidateRow): string[] {
  const raw = c.provenance?.source_run_ids;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.length > 0);
}

export async function promoteCandidate(
  candidate_id: string,
  deps: PromoteGateDeps = defaultDeps(),
): Promise<PromoteResult> {
  const { db, loadLiveAgentDef } = deps;

  const { data: cRaw, error: cErr } = await db
    .from("tenant_routines")
    .select(CANDIDATE_COLS)
    .eq("id", candidate_id)
    .maybeSingle();
  if (cErr) {
    return { candidate_id, outcome: "noop", reason: `candidate load failed: ${String((cErr as { message?: string }).message ?? cErr)}` };
  }
  const c = cRaw as CandidateRow | null;
  if (!c) {
    return { candidate_id, outcome: "noop", reason: "candidate not found" };
  }
  if (c.status !== "candidate") {
    return { candidate_id, outcome: "noop", reason: `candidate is status='${c.status}', not 'candidate'` };
  }

  const specCheck = validateRoutineSpec(c.routine_spec);
  if (!specCheck.ok) {
    return reject(db, candidate_id, `invalid_routine_spec: ${specCheck.reason}`);
  }
  const spec: RoutineSpecV1 = specCheck.spec;
  if (c.spec_version !== ROUTINE_SPEC_CURRENT_VERSION) {
    return reject(db, candidate_id, `spec_version mismatch: row has ${c.spec_version ?? "null"}, expected ${ROUTINE_SPEC_CURRENT_VERSION}`);
  }

  if (c.provenance_origin !== "tenant_authored") {
    if (c.founder_blessed !== true) {
      return reject(db, candidate_id, "not_founder_blessed: founder_blessed must be true (csat_signal is advisory only)");
    }

    const runIds = readSourceRunIds(c);
    if (runIds.length === 0) {
      return reject(db, candidate_id, "no_provenance: candidate links zero source agent_run ids (provenance.source_run_ids)");
    }
    const { data: runsRaw, error: rErr } = await db
      .from("agent_runs")
      .select("id, tenant_id, agent_slug, status, grounding_flags")
      .eq("tenant_id", c.tenant_id)
      .in("id", runIds)
      .then((r) => r);
    if (rErr) {
      return reject(db, candidate_id, `provenance_read_failed: ${String((rErr as { message?: string }).message ?? rErr)}`);
    }
    const runs = (runsRaw as AgentRunRow[] | null) ?? [];

    const byId = new Map(runs.map((r) => [r.id, r]));
    for (const id of runIds) {
      const r = byId.get(id);
      if (!r) {
        return reject(db, candidate_id, `invalid_provenance: source run ${id} not found for tenant ${c.tenant_id} (cross-tenant or missing)`);
      }
      if (r.agent_slug !== c.agent_slug) {
        return reject(db, candidate_id, `invalid_provenance: source run ${id} is agent '${r.agent_slug}', candidate is '${c.agent_slug}'`);
      }
    }
    const positiveCleanRuns = runs.filter(
      (r) => runIsPositiveOutcome(r) && runIsFaithfulnessClean(r),
    );
    if (positiveCleanRuns.length === 0) {
      return reject(db, candidate_id, "no_positive_clean_run: provenance has no faithfulness-clean success run");
    }
    if (runs.some((r) => !runIsFaithfulnessClean(r))) {
      return reject(db, candidate_id, "tainted_provenance: a linked source run has a hard grounding flag (not faithfulness-clean)");
    }
  }

  const live = await loadLiveAgentDef(c.agent_slug, c.tenant_id);
  if (!live) {
    return reject(db, candidate_id, `agent_def_missing: cannot resolve live definition for agent '${c.agent_slug}'`);
  }
  const liveMatches = makeLiveToolMatcher(live.tools);

  const granted = c.granted_tool_names ?? [];
  const escalating = granted.filter((t) => !liveMatches(t));
  if (escalating.length > 0) {
    return reject(db, candidate_id, `privilege_escalation: granted_tool_names not subset of live agent tools — extra: [${escalating.join(", ")}]`);
  }
  const specTools = toolsReferencedBySpec(spec);
  const specEscalating = specTools.filter((t) => !liveMatches(t));
  if (specEscalating.length > 0) {
    return reject(db, candidate_id, `privilege_escalation: routine_spec references tools the agent does not have — extra: [${specEscalating.join(", ")}]`);
  }
  const specUnroutable = specTools.filter((t) => !isRoutableRoutineStepTool(t));
  if (specUnroutable.length > 0) {
    return reject(db, candidate_id, `spec_tool_unroutable: routine_spec references tools the runner cannot route — extra: [${specUnroutable.join(", ")}]`);
  }

  const toolSnapshot = granted.filter((t) => liveMatches(t));
  const { error: upErr } = await db
    .from("tenant_routines")
    .update({
      status: "staged",
      provenance_agent_def_hash: live.def_hash,
      granted_tool_names: toolSnapshot,
      decided_at: new Date().toISOString(),
    })
    .eq("id", candidate_id)
    .eq("tenant_id", c.tenant_id)
    .eq("status", "candidate")
    .then((r) => r);
  if (upErr) {
    return { candidate_id, outcome: "noop", reason: `stage_write_failed: ${String((upErr as { message?: string }).message ?? upErr)}` };
  }

  return { candidate_id, outcome: "staged", reason: "all_gates_passed" };
}

async function reject(
  db: RoutineGateDb,
  candidate_id: string,
  reason: string,
): Promise<PromoteResult> {
  await db
    .from("tenant_routines")
    .update({ status: "rejected", decided_at: new Date().toISOString() })
    .eq("id", candidate_id)
    .eq("status", "candidate")
    .then((r) => r);
  return { candidate_id, outcome: "rejected", reason };
}

function defaultDeps(): PromoteGateDeps {
  return {
    db: serviceClient() as unknown as RoutineGateDb,
    loadLiveAgentDef: async (agent_slug, tenant_id) => {
      const def = await loadAgentDefinition(agent_slug, tenant_id);
      if (!def) return null;
      return {
        tools: def.metadata_praxis.tools ?? [],
        def_hash: def.content_hash,
      };
    },
  };
}
