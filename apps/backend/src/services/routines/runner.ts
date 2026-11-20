
import { serviceClient } from "@/services/supabase";
import { loadAgentDefinition } from "@/services/agents/registry";
import { validateRoutineSpec, type RoutineSpecV1 } from "./routine-spec";
import { hashValidatedRoutineSpec } from "./routine-spec-hash";
import { deriveRoutineTrustLevel, requiresExecutableGauntlet } from "./trust-level";
import { ROUTINE_SERVER_ID } from "./tool-name";
import { fromAnthropicName } from "@/services/mcp/types";
import { evaluateToolCallPolicy } from "@/services/agents/tool-call-policy";
import { discoverToolsForTenant } from "@/services/mcp/discovery";
import { makeLiveToolMatcher } from "@/services/mcp/declared-tool-match";

export const HARD_STEP_CEILING = 32;
export const MAX_ROUTINE_DEPTH = 1;

export interface RoutineStepCaller {
  (
    server_id: string,
    tool_name: string,
    args: unknown,
    step_idx: number,
  ): Promise<{ is_error: boolean; content: string }>;
}

export interface RoutineRunnerDb {
  from(table: string): RoutineRunnerQuery;
}
export interface RoutineRunnerQuery {
  select(cols: string): RoutineRunnerQuery;
  eq(col: string, val: unknown): RoutineRunnerQuery;
  maybeSingle(): Promise<{ data: unknown; error: unknown }>;
}

export interface LiveAgentTools {
  tools: string[];
  def_hash: string;
  output_envelope?: string;
}
export type LiveAgentToolsLoader = (
  agent_slug: string,
  tenant_id: string,
) => Promise<LiveAgentTools | null>;

export type RunToolsResolver = (
  tenant_id: string,
  declared_tools: readonly string[],
  agent_slug: string,
) => Promise<string[]>;

export interface RoutineRunnerDeps {
  db: RoutineRunnerDb;
  loadLiveAgentDef: LiveAgentToolsLoader;
  callStep: RoutineStepCaller;
  resolveRunTools: RunToolsResolver;
}

export interface RunRoutineInput {
  run_id: string;
  emitted_tool_name: string;
  untrusted_inbound?: boolean;
}

export interface RunRoutineResult {
  ok: boolean;
  content: string;
}

interface AgentRunRow {
  id: string;
  tenant_id: string;
  agent_slug: string;
}

interface RoutineRow {
  id: string;
  tenant_id: string;
  agent_slug: string;
  status: string;
  emitted_tool_name: string | null;
  routine_spec: unknown;
  granted_tool_names: string[] | null;
  provenance_agent_def_hash: string | null;
  approved_spec_hash: string | null;
  provenance_origin: string | null;
}

function err(content: string): RunRoutineResult {
  return { ok: false, content };
}

const ROUTINE_COLS =
  "id, tenant_id, agent_slug, status, emitted_tool_name, routine_spec, " +
  "granted_tool_names, provenance_agent_def_hash, approved_spec_hash, provenance_origin";

export async function runTenantRoutine(
  input: RunRoutineInput,
  deps: RoutineRunnerDeps = defaultDeps(),
): Promise<RunRoutineResult> {
  const { db, loadLiveAgentDef, callStep, resolveRunTools } = deps;

  if (!input.run_id) {
    return err(JSON.stringify({ error: "routine_no_run", message: "tenant-routine invocation has no run_id to derive tenant from" }));
  }
  const { data: runRaw, error: runErr } = await db
    .from("agent_runs")
    .select("id, tenant_id, agent_slug")
    .eq("id", input.run_id)
    .maybeSingle();
  if (runErr || !runRaw) {
    return err(JSON.stringify({ error: "routine_run_not_found", message: `agent_runs row ${input.run_id} not found for tenant re-derivation` }));
  }
  const run = runRaw as AgentRunRow;
  const tenant_id = run.tenant_id;
  const agent_slug = run.agent_slug;

  const { data: skillRaw, error: skillErr } = await db
    .from("tenant_routines")
    .select(ROUTINE_COLS)
    .eq("tenant_id", tenant_id)
    .eq("agent_slug", agent_slug)
    .eq("emitted_tool_name", input.emitted_tool_name)
    .eq("status", "approved")
    .maybeSingle();
  if (skillErr || !skillRaw) {
    return err(JSON.stringify({ error: "routine_not_found", message: `no approved tenant_skill '${input.emitted_tool_name}' for this agent + tenant` }));
  }
  const routine = skillRaw as RoutineRow;

  const specCheck = validateRoutineSpec(routine.routine_spec);
  if (!specCheck.ok) {
    return err(JSON.stringify({ error: "routine_spec_invalid", message: `routine_spec failed closed-union validation: ${specCheck.reason}` }));
  }
  const spec: RoutineSpecV1 = specCheck.spec;

  const trustLevel = deriveRoutineTrustLevel(routine.routine_spec);
  if (requiresExecutableGauntlet(trustLevel) && !routine.approved_spec_hash) {
    const origin = routine.provenance_origin ?? "machine_distilled";
    const legacyMachineExempt = origin === "machine_distilled";
    if (!legacyMachineExempt) {
      return err(JSON.stringify({ error: "routine_unpinned", message: `executable routine '${input.emitted_tool_name}' (trust_level=${trustLevel}) has no content-pin — refusing to execute an unpinned executable tenant routine` }));
    }
  }
  if (routine.approved_spec_hash) {
    const liveHash = hashValidatedRoutineSpec(spec);
    if (liveHash !== routine.approved_spec_hash) {
      return err(JSON.stringify({ error: "routine_spec_tampered", message: `routine_spec hash does not match the approved content-pin for '${input.emitted_tool_name}' — refusing to execute a directive that was mutated after approval` }));
    }
  }

  if (MAX_ROUTINE_DEPTH !== 1) {
    return err(JSON.stringify({ error: "routine_depth", message: "tenant-skills are flat (depth 1); nesting is not permitted" }));
  }
  if (spec.steps.length > HARD_STEP_CEILING) {
    return err(JSON.stringify({ error: "routine_budget", message: `routine has ${spec.steps.length} steps, exceeding the hard ceiling of ${HARD_STEP_CEILING}` }));
  }

  const live = await loadLiveAgentDef(agent_slug, tenant_id);
  if (!live) {
    return err(JSON.stringify({ error: "routine_agent_def_missing", message: `cannot resolve live definition for agent '${agent_slug}'` }));
  }
  const grantedSnapshot = routine.granted_tool_names ?? [];
  const liveMatches = makeLiveToolMatcher(live.tools);
  const effectiveGranted = new Set(grantedSnapshot.filter((t) => liveMatches(t)));

  const resolvedFromDiscovery = await resolveRunTools(tenant_id, live.tools, agent_slug);

  const resolvedToolNames = resolvedFromDiscovery.filter((name) => {
    const parts = fromAnthropicName(name);
    return parts?.server_id !== ROUTINE_SERVER_ID;
  });
  const researchScoped = live.output_envelope === "research_report";

  const outputs: Array<{ step: number; tool: string; ok: boolean; content: string }> = [];
  for (let i = 0; i < spec.steps.length; i++) {
    const step = spec.steps[i];
    const toolName = step.tool;

    const route = fromAnthropicName(toolName);
    if (!route) {
      return err(JSON.stringify({ error: "routine_tool_malformed", message: `step ${i} tool '${toolName}' is not a valid <server>__<tool> name` }));
    }

    if (route.server_id === ROUTINE_SERVER_ID) {
      return err(JSON.stringify({ error: "routine_recursion", message: `step ${i} references another tenant_skill ('${toolName}') — skills cannot invoke skills` }));
    }

    if (!effectiveGranted.has(toolName)) {
      return err(JSON.stringify({ error: "routine_tool_not_granted", message: `step ${i} references tool '${toolName}' which is not in the agent's current granted+live tool set` }));
    }

    const policy = evaluateToolCallPolicy({
      tool_name: toolName,
      resolved_tool_names: resolvedToolNames,
      research_scoped: researchScoped,
      agent_slug,
      untrusted_inbound: input.untrusted_inbound === true,
      tenant_id,
    });
    if (!policy.allow) {
      return err(JSON.stringify({ error: `routine_policy_denied:${policy.reason}`, message: `step ${i} tool '${toolName}' denied by shared tool-call policy: ${policy.synthetic_tool_result}` }));
    }

    let result: { is_error: boolean; content: string };
    try {
      result = await callStep(route.server_id, route.tool_name, step.args, i);
    } catch (e) {
      return err(JSON.stringify({ error: "routine_step_threw", message: `step ${i} ('${toolName}') threw: ${(e as Error).message}` }));
    }
    outputs.push({ step: i, tool: toolName, ok: !result.is_error, content: result.content });
    if (result.is_error) {
      return {
        ok: false,
        content: JSON.stringify({ error: "routine_step_failed", failed_step: i, tool: toolName, step_error: result.content, completed: outputs }),
      };
    }
  }

  return { ok: true, content: JSON.stringify({ routine: input.emitted_tool_name, steps: outputs }) };
}

export function defaultDeps(): RoutineRunnerDeps {
  return {
    db: serviceClient() as unknown as RoutineRunnerDb,
    loadLiveAgentDef: async (agent_slug, tenant_id) => {
      const def = await loadAgentDefinition(agent_slug, tenant_id);
      if (!def) return null;
      return {
        tools: def.metadata_praxis.tools ?? [],
        def_hash: def.content_hash,
        output_envelope: def.metadata_praxis.output_envelope,
      };
    },
    callStep: () => {
      throw new Error("runTenantRoutine: callStep must be injected by the execute.ts routing seam");
    },
    resolveRunTools: async (tenant_id, declared_tools, agent_slug) => {
      const d = await discoverToolsForTenant(tenant_id, [...declared_tools], agent_slug);
      return d.tools.map((t) => t.name);
    },
  };
}
