
import { asTenantId, tenantClient, type TenantId } from "@/services/tenant-client";
import { getBoolSetting } from "@/services/settings";
import type { serverClientFromBearer } from "@/services/supabase";
import {
  SETUP_DRAFT_IN_FLIGHT,
  SETUP_DRAFT_MAX_ATTEMPTS,
  setupDraftAttempt,
  setupDraftPrefix,
  sortSetupRuns,
  type SetupDraftRun,
} from "@/services/growth/setup-draft";

export type StepStatus = "pending" | "done" | "skipped";
export type SetupDraftStatus = "none" | "running" | "failed" | "done";

export type ProgressRow = {
  setup_docs_at: string | null;
  setup_docs_skipped: boolean;
  setup_connectors_at: string | null;
  setup_connectors_skipped: boolean;
  setup_done_at: string | null;
  setup_home_at: string | null;
};

export type SetupState = {
  enabled: true;
  docs: { status: StepStatus; files: number; facts: number };
  connectors: { status: StepStatus };
  done: boolean;
  home_seen: boolean;
  has_plan: boolean;
  draft: { phase?: "writing" | "checking" | "saving"; save_retry?: boolean; status: SetupDraftStatus; run_id: string | null; attempts: number; can_retry: boolean; free_retry: boolean };
};

export type SetupResponse = SetupState | { enabled: false };

function step(at: string | null | undefined, skipped: boolean | undefined): StepStatus {
  if (!at) return "pending";
  return skipped ? "skipped" : "done";
}

export function deriveSetupState(input: {
  tenant_id: string;
  row: ProgressRow | null;
  files: number;
  facts: number;
  runs: readonly SetupDraftRun[];
  hasPlan: boolean;
  delivery?: { phase: string; plan_id: string | null; has_artifact?: boolean } | null;
  livePlanIds?: string[];
  laterPlan?: boolean;
}): SetupState {
  const row = input.row;
  const runs = sortSetupRuns(input.tenant_id, input.runs);
  const latest = runs[0] ?? null;
  const attempts = latest ? (setupDraftAttempt(input.tenant_id, latest.cron_dedupe_key) ?? 0) : 0;
  let status: SetupDraftStatus = "none";
  if (latest) {
    if (input.delivery?.phase === "applied" && input.delivery.plan_id && (input.livePlanIds?.includes(input.delivery.plan_id) || input.hasPlan)) status = "done";
    else if (input.delivery?.phase === "superseded" || (input.delivery?.phase === "failed" && input.laterPlan)) status = "done";
    else if (input.delivery?.phase === "failed") status = "failed";
    else if ((SETUP_DRAFT_IN_FLIGHT as readonly string[]).includes(latest.status)) status = "running";
    else if (!input.delivery && latest.status === "success" && input.hasPlan) status = "done";
    else status = "failed";
  }
  return {
    enabled: true,
    docs: { status: step(row?.setup_docs_at, row?.setup_docs_skipped), files: input.files, facts: input.facts },
    connectors: { status: step(row?.setup_connectors_at, row?.setup_connectors_skipped) },
    done: !!row?.setup_done_at,
    home_seen: !!row?.setup_home_at,
    has_plan: input.hasPlan,
    draft: {
      status,
      ...(status === "running" ? { phase: input.delivery?.phase === "checking" ? "checking" as const : input.delivery?.phase === "saving" ? "saving" as const : "writing" as const } : {}),
      ...(input.delivery?.has_artifact && input.delivery.phase !== "superseded" ? { save_retry: true } : {}),
      run_id: latest?.id ?? null,
      attempts,
      can_retry: status === "failed",
      free_retry: status === "failed" && attempts < SETUP_DRAFT_MAX_ATTEMPTS,
    },
  };
}

const PROGRESS_COLS =
  "setup_docs_at, setup_docs_skipped, setup_connectors_at, setup_connectors_skipped, setup_done_at, setup_home_at";

export async function readProgressRow(tid: TenantId): Promise<ProgressRow | null> {
  const { data, error } = await tenantClient(tid)
    .from("tenant_first_run_progress")
    .select(PROGRESS_COLS)
    .maybeSingle();
  if (error) throw new Error(`setup progress read failed: ${error.message}`);
  return (data as ProgressRow | null) ?? null;
}

export async function readSetupDraftRuns(tid: TenantId): Promise<SetupDraftRun[]> {
  const { data, error } = await tenantClient(tid)
    .from("agent_runs")
    .select("id, status, cron_dedupe_key, trigger, enqueued_by, agent_slug, enqueued_at")
    .eq("agent_slug", "cgo")
    .eq("trigger", "a2a")
    .is("enqueued_by", null)
    .like("cron_dedupe_key", `${setupDraftPrefix(tid)}%`)
    .order("enqueued_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);
  if (error) throw new Error(`setup draft read failed: ${error.message}`);
  return (data ?? []) as SetupDraftRun[];
}

export async function readSetupState(
  tenant_id: string,
  bearer: ReturnType<typeof serverClientFromBearer>,
): Promise<SetupState> {
  const tid = asTenantId(tenant_id);
  const db = tenantClient(tid);
  const [row, filesRes, factsRes, runs, planRes] = await Promise.all([
    readProgressRow(tid),
    db.from("tenant_document").select("id", { count: "exact", head: true }).eq("status", "imported"),
    db
      .from("memory_note")
      .select("id", { count: "exact", head: true })
      .eq("source", "document_import")
      .is("superseded_by", null),
    readSetupDraftRuns(tid),
    bearer.from("growth_plan").select("id, created_at").eq("tenant_id", tenant_id).eq("status", "live").limit(1),
  ]);
  if (filesRes.error) throw new Error(`imported files count failed: ${filesRes.error.message}`);
  if (factsRes.error) throw new Error(`imported facts count failed: ${factsRes.error.message}`);
  if (planRes.error) throw new Error(`plan read failed: ${planRes.error.message}`);
  let delivery: { phase: string; plan_id: string | null; has_artifact: boolean } | null = null;
  if (runs[0]) {
    const { data, error } = await db.from("growth_strategy_delivery")
      .select("phase, plan_id, artifact_present:artifact->title").eq("run_id", runs[0].id).maybeSingle();
    if (error) throw new Error("strategy delivery read failed");
    const receipt = data as { phase: string; plan_id: string | null; artifact_present: string | null } | null;
    if (receipt) delivery = { phase: receipt.phase, plan_id: receipt.plan_id, has_artifact: !!receipt.artifact_present };
  }
  return deriveSetupState({
    delivery,
    livePlanIds: (planRes.data ?? []).map(p => p.id),
    laterPlan: !!runs[0]?.enqueued_at && (planRes.data ?? []).some(p => Date.parse(p.created_at) > Date.parse(runs[0].enqueued_at as string)),
    tenant_id,
    row,
    files: filesRes.count ?? 0,
    facts: factsRes.count ?? 0,
    runs,
    hasPlan: (planRes.data ?? []).length > 0,
  });
}

export async function isSetupActive(tenant_id: string): Promise<boolean> {
  if (!(await getBoolSetting("welcome_setup_enabled", tenant_id))) return false;
  const row = await readProgressRow(asTenantId(tenant_id));
  return !row?.setup_done_at;
}
