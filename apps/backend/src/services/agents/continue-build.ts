
import { asTenantId, fleetSweepClient, tenantClient, tenantRpc } from "@/services/tenant-client";
import type { ConductorNode } from "./conductor";
import { siteIdFromGraph } from "@/services/sites/site-run";
import { OLD_SITE_FROZEN_MESSAGE } from "@/services/sites/old-site-freeze";
import { siteSetupMarker, siteSetupRetryable } from "./site-setup-marker";
import { stampConductorOwner } from "./conductor-owner";

export const CONTINUE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type ContinueBuildResult =
  | { ok: true; run_id: string }
  | {
      ok: false;
      code:
        | "not_found"
        | "not_paused"
        | "not_resumable"
        | "budget_spent"
        | "expired"
        | "superseded"
        | "another_build_running"
        | "changed_concurrently"
        | "old_site_frozen"
        | "site_setup_failed";
      message: string;
      retryable?: boolean;
      reason_code?: string;
    };

type Row = {
  id: string;
  tenant_id: string;
  kind: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  paused_at: string | null;
  failure_class?: string | null;
  spend_usd?: number | string | null;
  max_usd?: number | string | null;
  goal_graph: ConductorNode[];
};

const isRefineGraph = (g: unknown): boolean =>
  Array.isArray(g) &&
  (g[0] as { payload?: { refine_mode?: unknown } } | undefined)?.payload?.refine_mode === true;

export function supersedes(
  run: { created_at: string; goal_graph: unknown },
  other: { created_at: string; goal_graph: unknown; objective?: string | null },
): boolean {
  if (isRefineGraph(other.goal_graph) || (other.objective ?? "").startsWith("[refine]")) return false;
  if (!(other.created_at > run.created_at)) return false;
  return siteIdFromGraph(other.goal_graph) === siteIdFromGraph(run.goal_graph);
}

export function resumeGraph(graph: ConductorNode[]): ConductorNode[] {
  return graph.map((n) => {
    if (n.status !== "failed") return n;
    const payload = { ...(n.payload ?? {}) } as Record<string, unknown>;
    delete payload.deploy_enqueued_at;
    delete payload.push_check_started_at;
    delete payload.refine_deploy_enqueued_at;
    const epoch = typeof payload.resume_epoch === "number" ? payload.resume_epoch : 0;
    payload.resume_epoch = epoch + 1;
    return {
      ...n,
      status: "pending",
      child_run_id: null,
      error: null,
      failure_class: null,
      finished_at: null,
      last_failure_signal: undefined,
      repair_attempts: 0,
      acceptance_attempts: 0,
      acceptance_reprobe_pending: false,
      payload,
    } as ConductorNode;
  });
}

export type ContinueRefusalCode = "not_found" | "not_paused" | "expired" | "not_resumable" | "budget_spent";

const NOT_RETRYABLE: ReadonlySet<string> = new Set(["user_cancelled", "provision_failed", "coach_precedence"]);

export function continueRefusal(
  row: {
    kind?: string | null;
    status?: string | null;
    paused_at?: string | null;
    updated_at?: string | null;
    failure_class?: string | null;
    spend_usd?: number | string | null;
    max_usd?: number | string | null;
    goal_graph?: unknown;
  } | null,
  now: number = Date.now(),
): ContinueRefusalCode | null {
  if (!row || row.kind !== "build_app" || isRefineGraph(row.goal_graph)) return "not_found";
  if (row.status === "failed") {
    if (row.paused_at) return "expired";
    const failedAt = row.updated_at ? Date.parse(row.updated_at) : NaN;
    if (!Number.isFinite(failedAt) || now - failedAt > CONTINUE_WINDOW_MS) return "expired";
    const graph = Array.isArray(row.goal_graph) ? (row.goal_graph as Array<{ status?: unknown } | null>) : [];
    const setupRetry = row.failure_class === "provision_failed" && siteSetupRetryable(row.goal_graph);
    if ((NOT_RETRYABLE.has(row.failure_class ?? "") && !setupRetry) || !graph.some((n) => n?.status === "failed")) return "not_resumable";
    const spend = Number(row.spend_usd ?? 0);
    const cap = row.max_usd === null || row.max_usd === undefined || row.max_usd === "" ? NaN : Number(row.max_usd);
    if (Number.isFinite(cap) && spend >= cap) return "budget_spent";
    return null;
  }
  if (row.status !== "paused") return "not_paused";
  const pausedAt = row.paused_at ? Date.parse(row.paused_at) : NaN;
  if (!Number.isFinite(pausedAt) || now - pausedAt > CONTINUE_WINDOW_MS) return "expired";
  return null;
}

export const SITE_CLEANED_UP =
  "This build's site was cleaned up after it failed, so it can't be retried. Start a new build.";

export async function continueBuild(
  tenant_id: string,
  run_id: string,
  now: number = Date.now(),
): Promise<ContinueBuildResult> {
  const tid = asTenantId(tenant_id);
  const sb = tenantClient(tid);
  const { data, error } = await sb
    .from("conductor_runs")
    .select("id, tenant_id, kind, status, created_at, updated_at, paused_at, failure_class, spend_usd, max_usd, goal_graph")
    .eq("id", run_id)
    .maybeSingle();
  if (error) throw new Error(`continueBuild: read failed: ${error.message}`);
  const row = data as Row | null;
  const refusal = continueRefusal(row, now);
  if (!row || refusal === "not_found") {
    return { ok: false, code: "not_found", message: "Build not found." };
  }
  if (
    Array.isArray(row.goal_graph) &&
    row.goal_graph.length > 0 &&
    !siteIdFromGraph(row.goal_graph) &&
    !siteSetupMarker(row.goal_graph)
  ) {
    return { ok: false, code: "old_site_frozen", message: OLD_SITE_FROZEN_MESSAGE };
  }
  if (refusal) {
    const startOver = "Start a new build.";
    const message =
      refusal === "not_paused"
        ? "This build is not paused."
        : refusal === "not_resumable"
          ? `This build can't be retried from where it stopped. ${startOver}`
          : refusal === "budget_spent"
            ? `This build used its whole budget, so it can't be retried. ${startOver}`
            : row.status === "failed" && !row.paused_at
              ? `This build failed more than 7 days ago and can't be retried. ${startOver}`
              : `This build was paused for more than 7 days and can't be continued. ${startOver}`;
    return { ok: false, code: refusal, message };
  }

  if (row.status === "failed" && row.failure_class === "provision_failed" && siteSetupRetryable(row.goal_graph)) {
    const { retrySiteSetup } = await import("./start-product-build");
    return retrySiteSetup(tenant_id, row);
  }

  const { data: others, error: othersErr } = await sb
    .from("conductor_runs")
    .select("id, status, created_at, objective, goal_graph")
    .eq("kind", "build_app")
    .neq("id", run_id)
    .gt("created_at", row.created_at);
  if (othersErr) throw new Error(`continueBuild: sibling read failed: ${othersErr.message}`);
  const siblings = (others ?? []) as Array<Pick<Row, "id" | "status" | "created_at" | "goal_graph"> & { objective?: string | null }>;
  if (siblings.some((o) => supersedes(row, o))) {
    return {
      ok: false,
      code: "superseded",
      message: "A newer build replaced this one. Open your latest build instead.",
    };
  }
  const { data: outcome, error: rpcErr } = await tenantRpc(tid, "continue_paused_build_with_site", {
    p_run_id: run_id,
    p_expected_updated_at: row.updated_at,
    p_goal_graph: stampConductorOwner(resumeGraph(row.goal_graph), { replace: true }),
    p_site_id: siteIdFromGraph(row.goal_graph) ?? null,
  });
  if (rpcErr) throw new Error(`continueBuild: resume failed: ${rpcErr.message}`);
  if (outcome === "site_gone") return { ok: false, code: "not_resumable", message: SITE_CLEANED_UP };
  if (outcome === "superseded") {
    return {
      ok: false,
      code: "superseded",
      message: "A newer build replaced this one. Open your latest build instead.",
    };
  }
  if (outcome === "another_build_running") {
    return {
      ok: false,
      code: "another_build_running",
      message: "Another build is running. Wait for it to finish, then continue.",
    };
  }
  if (outcome !== "resumed") {
    return {
      ok: false,
      code: "changed_concurrently",
      message: "This build changed while resuming. Refresh and try again.",
    };
  }
  return { ok: true, run_id };
}

export async function expireStalePausedBuilds(now: number = Date.now()): Promise<number> {
  const cutoff = new Date(now - CONTINUE_WINDOW_MS).toISOString();
  const { data, error } = await fleetSweepClient("expire paused builds past the 7-day continue window")
    .from("conductor_runs")
    .update({
      status: "failed",
      failure_reason: "Paused for more than 7 days, so it can no longer be continued. Start a new build.",
      updated_at: new Date(now).toISOString(),
    })
    .eq("status", "paused")
    .lt("paused_at", cutoff)
    .select("id");
  if (error) throw new Error(`expireStalePausedBuilds: ${error.message}`);
  return (data ?? []).length;
}

export const STRANDED_SITE_REPUBLISH_MS = 5 * 60_000;

export async function resumeStrandedSiteRepublishes(now: number = Date.now()): Promise<number> {
  const cutoff = new Date(now - STRANDED_SITE_REPUBLISH_MS).toISOString();
  const { data, error } = await fleetSweepClient("resume site republishes stranded after an undo")
    .from("conductor_runs")
    .update({ status: "active", updated_at: new Date(now).toISOString() })
    .eq("status", "provisioning")
    .lt("updated_at", cutoff)
    .eq("goal_graph->0->payload->>republish", "true")
    .not("goal_graph->0->payload->>site_id", "is", null)
    .select("id, tenant_id");
  if (error) throw new Error(`resumeStrandedSiteRepublishes: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; tenant_id: string }>;
  for (const r of rows) {
    console.warn(JSON.stringify({ evt: "site_republish.resumed_stranded", conductor_run_id: r.id, tenant_id: r.tenant_id }));
  }
  return rows.length;
}
