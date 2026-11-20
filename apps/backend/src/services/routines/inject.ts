
import { serviceClient } from "@/services/supabase";
import type { ResolvedTool } from "@/services/mcp/discovery";
import { isValidEmittedToolName } from "./tool-name";
import { getBoolSetting } from "@/services/settings";

export interface RoutineInjectDb {
  from(table: string): RoutineInjectQuery;
}
export interface RoutineInjectQuery {
  select(cols: string): RoutineInjectQuery;
  update(values: Record<string, unknown>): RoutineInjectQuery;
  eq(col: string, val: unknown): RoutineInjectQuery;
  then<T>(onfulfilled: (v: { data: unknown; error: unknown }) => T): Promise<T>;
}

export interface ApprovedRoutineRow {
  id: string;
  tenant_id: string;
  agent_slug: string;
  emitted_tool_name: string | null;
  routine_name: string | null;
  source_note_ids: string[] | null;
  provenance: { external?: unknown } | null;
  faithfulness_clean: boolean | null;
  provenance_origin: string | null;
}

const APPROVED_COLS =
  "id, tenant_id, agent_slug, emitted_tool_name, routine_name, " +
  "source_note_ids, provenance, faithfulness_clean, provenance_origin";

export async function loadApprovedTenantRoutinesForAgent(
  tenantId: string,
  agentSlug: string,
  db: RoutineInjectDb = serviceClient() as unknown as RoutineInjectDb,
): Promise<ApprovedRoutineRow[]> {
  if (!tenantId || !agentSlug) return [];
  const { data, error } = await db
    .from("tenant_routines")
    .select(APPROVED_COLS)
    .eq("tenant_id", tenantId)
    .eq("agent_slug", agentSlug)
    .eq("status", "approved")
    .then((r) => r);
  if (error) {
    console.warn(
      `[routines/inject] approved-routine read failed for tenant=${tenantId} agent=${agentSlug}: ${String((error as { message?: string }).message ?? error)} — degrading to no skills`,
    );
    return [];
  }
  return ((data as ApprovedRoutineRow[] | null) ?? []);
}

async function quarantineRow(db: RoutineInjectDb, id: string, tenantId: string): Promise<void> {
  await db
    .from("tenant_routines")
    .update({ status: "quarantined", decided_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .eq("status", "approved")
    .then((r) => r);
}

function provenanceDescription(row: ApprovedRoutineRow): string {
  const n = Array.isArray(row.source_note_ids) ? row.source_note_ids.length : 0;
  const external = !!(row.provenance && (row.provenance as { external?: unknown }).external);
  const date = new Date().toISOString().slice(0, 10);
  const sources = `${n} source${n === 1 ? "" : "s"}${external ? " +external" : ""}`;
  const clean = row.faithfulness_clean === true;
  const display = (row.routine_name ?? "learned routine").slice(0, 120);
  return (
    `Learned tenant routine: ${display}. ` +
    `Learned from ${sources} on ${date}; review before use. ` +
    `faithfulness_clean=${clean}. ` +
    `This is a closed, deterministic replay of a previously-successful tool sequence for this agent.`
  );
}

const ROUTINE_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

export async function synthesizeApprovedRoutineTools(
  tenantId: string,
  agentSlug: string,
  db: RoutineInjectDb = serviceClient() as unknown as RoutineInjectDb,
  isTenantSkillsEnabled: (tenant_id: string) => Promise<boolean> = (t) =>
    getBoolSetting("tenant_executable_skills_enabled", t),
): Promise<ResolvedTool[]> {
  const rows = await loadApprovedTenantRoutinesForAgent(tenantId, agentSlug, db);
  const enabled = await isTenantSkillsEnabled(tenantId);
  const visibleRows = enabled
    ? rows
    : rows.filter((r) => r.provenance_origin !== "tenant_authored");
  const out: ResolvedTool[] = [];
  for (const row of visibleRows) {
    if (!isValidEmittedToolName(row.emitted_tool_name, agentSlug)) {
      await quarantineRow(db, row.id, tenantId);
      console.warn(
        `[routines/inject] quarantined routine ${row.id} (tenant=${tenantId} agent=${agentSlug}): invalid emitted_tool_name '${row.emitted_tool_name ?? "<null>"}'`,
      );
      continue;
    }
    const name = row.emitted_tool_name as string;
    out.push({
      name,
      description: provenanceDescription(row),
      input_schema: ROUTINE_INPUT_SCHEMA,
      server_id: "tenant_skill",
      tool_name: name.slice("tenant_skill__".length),
    });
  }
  return out;
}
