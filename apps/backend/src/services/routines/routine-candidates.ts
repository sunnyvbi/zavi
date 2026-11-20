
import { serviceClient } from "@/services/supabase";
import { loadAgentDefinition } from "@/services/agents/registry";
import {
  validateRoutineSpec,
  toolsReferencedBySpec,
  ROUTINE_SPEC_CURRENT_VERSION,
} from "./routine-spec";
import { synthesizeRoutineToolName, isRoutableRoutineStepTool } from "./tool-name";
import { promoteCandidate } from "./promote-gate";
import { makeLiveToolMatcher } from "@/services/mcp/declared-tool-match";
import { hashValidatedRoutineSpec } from "./routine-spec-hash";

export type RoutineApproveResult = {
  approved: boolean;
  reason: string;
  candidate_id: string;
  emitted_tool_name?: string;
};

type StagedRow = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  status: string;
  routine_spec: unknown;
  spec_version: number | null;
  granted_tool_names: string[] | null;
  emitted_tool_name: string | null;
};

const ROW_COLS =
  "id, tenant_id, agent_slug, status, routine_spec, spec_version, " +
  "granted_tool_names, emitted_tool_name";

async function rollToRejected(
  sb: ReturnType<typeof serviceClient>,
  candidate_id: string,
  decided_by: string,
  reason: string,
  fromStatus: "staged" | "candidate" = "staged",
): Promise<void> {
  await sb
    .from("tenant_routines")
    .update({
      status: "rejected",
      decided_by,
      decided_at: new Date().toISOString(),
    })
    .eq("id", candidate_id)
    .eq("status", fromStatus);
}

export async function approveRoutineCandidate(
  candidate_id: string,
  decided_by: string,
): Promise<RoutineApproveResult> {
  const sb = serviceClient();

  {
    const { data: blessedRaw } = await sb
      .from("tenant_routines")
      .update({ founder_blessed: true, decided_by, decided_at: new Date().toISOString() })
      .eq("id", candidate_id)
      .eq("status", "candidate")
      .select("id")
      .maybeSingle();
    if (blessedRaw) {
      const promo = await promoteCandidate(candidate_id);
      if (promo.outcome === "rejected") {
        return { approved: false, reason: `promote_rejected: ${promo.reason}`, candidate_id };
      }
      if (promo.outcome !== "staged") {
      }
    }
  }

  const { data: rowRaw } = await sb
    .from("tenant_routines")
    .select(ROW_COLS)
    .eq("id", candidate_id)
    .eq("status", "staged")
    .maybeSingle();
  const c = rowRaw as StagedRow | null;
  if (!c) {
    return { approved: false, reason: "candidate not staged (already decided or missing)", candidate_id };
  }

  const specCheck = validateRoutineSpec(c.routine_spec);
  if (!specCheck.ok) {
    await rollToRejected(sb, candidate_id, decided_by, `invalid_routine_spec: ${specCheck.reason}`);
    return { approved: false, reason: `invalid_routine_spec: ${specCheck.reason}`, candidate_id };
  }
  if (c.spec_version !== ROUTINE_SPEC_CURRENT_VERSION) {
    await rollToRejected(sb, candidate_id, decided_by, `spec_version mismatch (have ${c.spec_version ?? "null"})`);
    return { approved: false, reason: "spec_version_mismatch", candidate_id };
  }

  const def = await loadAgentDefinition(c.agent_slug, c.tenant_id);
  if (!def) {
    await rollToRejected(sb, candidate_id, decided_by, `agent_def_missing for '${c.agent_slug}'`);
    return { approved: false, reason: "agent_def_missing", candidate_id };
  }
  const liveMatches = makeLiveToolMatcher(def.metadata_praxis.tools ?? []);
  const granted = c.granted_tool_names ?? [];
  const grantedSet = new Set(granted);
  const escalating = granted.filter((t) => !liveMatches(t));
  if (escalating.length > 0) {
    await rollToRejected(sb, candidate_id, decided_by, `privilege_escalation: granted not ⊆ live — extra [${escalating.join(", ")}]`);
    return { approved: false, reason: "privilege_escalation", candidate_id };
  }
  const specTools = toolsReferencedBySpec(specCheck.spec);
  const specEscalating = specTools.filter((t) => !liveMatches(t));
  if (specEscalating.length > 0) {
    await rollToRejected(sb, candidate_id, decided_by, `privilege_escalation: spec references non-live tools [${specEscalating.join(", ")}]`);
    return { approved: false, reason: "privilege_escalation_spec", candidate_id };
  }
  const specNotGranted = specTools.filter((t) => !grantedSet.has(t));
  if (specNotGranted.length > 0) {
    await rollToRejected(sb, candidate_id, decided_by, `unrunnable_skill: spec references tools not in granted_tool_names [${specNotGranted.join(", ")}]`);
    return { approved: false, reason: "spec_tool_not_granted", candidate_id };
  }
  const specUnroutable = specTools.filter((t) => !isRoutableRoutineStepTool(t));
  if (specUnroutable.length > 0) {
    await rollToRejected(sb, candidate_id, decided_by, `spec_tool_unroutable: spec references tools the runner cannot route [${specUnroutable.join(", ")}]`);
    return { approved: false, reason: "spec_tool_unroutable", candidate_id };
  }

  const synth = synthesizeRoutineToolName(c.agent_slug, c.id);
  if (!synth.ok) {
    await sb
      .from("tenant_routines")
      .update({ status: "quarantined", decided_by, decided_at: new Date().toISOString() })
      .eq("id", candidate_id)
      .eq("status", "staged");
    return { approved: false, reason: `tool_name_synthesis_failed: ${synth.reason}`, candidate_id };
  }

  const approved_spec_hash = hashValidatedRoutineSpec(specCheck.spec);

  const { data: claimedRaw, error: claimErr } = await sb
    .from("tenant_routines")
    .update({
      status: "approved",
      emitted_tool_name: synth.tool_name,
      approved_spec_hash,
      decided_by,
      decided_at: new Date().toISOString(),
    })
    .eq("id", candidate_id)
    .eq("tenant_id", c.tenant_id)
    .eq("status", "staged")
    .select("id")
    .maybeSingle();
  if (claimErr) {
    return { approved: false, reason: `approve_write_failed: ${claimErr.message}`, candidate_id };
  }
  if (!claimedRaw) {
    return { approved: false, reason: "lost_claim_or_not_staged", candidate_id };
  }

  return { approved: true, reason: "approved", candidate_id, emitted_tool_name: synth.tool_name };
}

export async function rejectRoutineCandidate(
  candidate_id: string,
  decided_by: string,
): Promise<{ rejected: boolean; reason: string; candidate_id: string }> {
  const sb = serviceClient();
  const { data } = await sb
    .from("tenant_routines")
    .update({ status: "rejected", decided_by, decided_at: new Date().toISOString() })
    .eq("id", candidate_id)
    .in("status", ["staged", "candidate"])
    .select("id")
    .maybeSingle();
  if (!data) {
    return { rejected: false, reason: "candidate not staged/candidate (already decided or missing)", candidate_id };
  }
  return { rejected: true, reason: "founder_rejected", candidate_id };
}
