import { getBoolSetting } from "@/services/settings";
import { rowHasSiteMarker, SITE_MARKER_SELECT } from "@/services/sites/site-run";
import { PROVISION_MARKER_SELECT, replacesOldApp, type ReplaceEvidenceRow } from "@/services/agents/build-sessions";

export const NON_REFINE_BUILD_FILTER =
  "goal_graph->0->payload->>refine_mode.is.null,goal_graph->0->payload->>refine_mode.neq.true";

export function isRefineRun(run: { goal_graph?: unknown } | null | undefined): boolean {
  const graph =
    (run?.goal_graph as Array<{ payload?: { refine_mode?: boolean } | null }> | null) ?? [];
  return graph[0]?.payload?.refine_mode === true;
}

export function tenantAppIsLive(
  recentRuns:
    | ReadonlyArray<{ status?: string | null; goal_graph?: unknown }>
    | null
    | undefined,
): boolean {
  for (const run of recentRuns ?? []) {
    if (isRefineRun(run)) continue;
    return run.status === "done";
  }
  return false;
}

export function buildDatabaseReclaimed(
  resources:
    | ReadonlyArray<{ resource_kind: string; status: string; updated_at?: string | null }>
    | null
    | undefined,
  latestFreshBuild: { created_at?: string | null } | null | undefined,
): boolean {
  const db = (resources ?? []).find((r) => r.resource_kind === "db");
  if (!db || (db.status !== "torn_down" && db.status !== "teardown")) return false;
  if (!latestFreshBuild) return true;
  const reclaimedAt = Date.parse(db.updated_at ?? "");
  const builtAt = Date.parse(latestFreshBuild.created_at ?? "");
  if (Number.isNaN(reclaimedAt) || Number.isNaN(builtAt)) return false;
  return reclaimedAt > builtAt;
}

type FreshRunsQuery = {
  select(columns: string): FreshRunsQuery;
  eq(column: string, value: string): FreshRunsQuery;
  or(filter: string): FreshRunsQuery;
  is(column: string, value: null): FreshRunsQuery;
  order(column: string, options: { ascending: boolean }): FreshRunsQuery;
  limit(count: number): PromiseLike<{ data: unknown; error: unknown }>;
};

const OLD_FLOW_CURRENT_WINDOW = 20;

export async function oldFlowBuildUnshipped(
  sb: { from: (table: string) => unknown },
  tenantId: string,
): Promise<boolean> {
  try {
    if (!(await getBoolSetting("build_domains_wait_for_build", tenantId))) return false;
    const { data, error } = await (sb.from("conductor_runs") as FreshRunsQuery)
      .select(`status, failure_class, ${PROVISION_MARKER_SELECT}, ${SITE_MARKER_SELECT}`)
      .eq("tenant_id", tenantId)
      .eq("kind", "build_app")
      .or(NON_REFINE_BUILD_FILTER)
      .is("goal_graph->0->payload->>site_id", null)
      .is("goal_graph->1->payload->>site_id", null)
      .is("goal_graph->2->payload->>site_id", null)
      .order("created_at", { ascending: false })
      .limit(OLD_FLOW_CURRENT_WINDOW);
    if (error) return false;
    const rows = ((data ?? []) as Array<ReplaceEvidenceRow & { s0?: unknown; s1?: unknown; s2?: unknown }>).filter(
      (r) => !rowHasSiteMarker(r),
    );
    const current = rows.find((r) => replacesOldApp(r)) ?? rows[0];
    return current !== undefined && !tenantAppIsLive([current]);
  } catch {
    return false;
  }
}
