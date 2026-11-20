
import { asTenantId, tenantClient } from "@/services/tenant-client";

export const CURRENT_STRATEGY_TAG = "current-growth-strategy";

export type StrategyNote = {
  id: string;
  title: string;
  body_markdown: string;
  tags: string[];
  metadata: Record<string, unknown>;
};

export async function readStrategyNote(tenant_id: string): Promise<StrategyNote | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("memory_note")
    .select("id, title, body_markdown, tags, metadata")
    .eq("note_type", "growth_strategy")
    .contains("tags", [CURRENT_STRATEGY_TAG])
    .is("superseded_by", null)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`strategy note read failed: ${error.message}`);
  const row = (data?.[0] ?? null) as Partial<StrategyNote> | null;
  if (!row?.id) return null;
  return {
    id: row.id,
    title: row.title ?? "Growth strategy",
    body_markdown: row.body_markdown ?? "",
    tags: row.tags ?? [CURRENT_STRATEGY_TAG],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

export async function readRunCreatedAt(
  tenant_id: string,
  run_id: string,
): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("enqueued_at")
    .eq("id", run_id)
    .limit(1);
  if (error) return null;
  const at = (data?.[0] as { enqueued_at?: unknown } | undefined)?.enqueued_at;
  return typeof at === "string" ? at : null;
}

export const APPLY_STATE_KEYS = [
  "applied_fingerprint",
  "applied_spine",
  "applied_goal_id",
  "reset_at",
] as const;

export function carryApplyState(
  prior: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of APPLY_STATE_KEYS) if (prior[k] !== undefined) out[k] = prior[k];
  return out;
}

export function startedBeforeReset(
  runCreatedAt: string | null,
  resetAt: unknown,
): boolean {
  if (!runCreatedAt || typeof resetAt !== "string") return false;
  const run = Date.parse(runCreatedAt);
  const reset = Date.parse(resetAt);
  return Number.isFinite(run) && Number.isFinite(reset) && run < reset;
}
