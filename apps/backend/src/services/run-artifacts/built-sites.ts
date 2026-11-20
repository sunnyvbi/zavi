import { asTenantId, tenantClient } from "@/services/tenant-client";
import { liveUrlFromResources, siteNameFromObjective } from "@/services/build/build-live-email";
import { publishUrlFromResources } from "@/services/build/app-ready";
import { oldFlowBuildUnshipped } from "@/services/autopilot/build-liveness";

export type OldFlowBuiltApp = {
  name: string;
  hostname: string | null;
  live_url: string;
  build_run_id: string | null;
  updated_at: string | null;
};

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export async function oldFlowBuiltApp(tenantId: string): Promise<OldFlowBuiltApp | null> {
  const db = tenantClient(asTenantId(tenantId));
  const { data: resources, error } = await db
    .from("tenant_resources")
    .select("resource_kind, status, external_ref, updated_at")
    .eq("tenant_id", tenantId);
  if (error) return null;
  const rows = (resources ?? []) as Array<{ resource_kind?: string; status?: string; external_ref?: unknown; updated_at?: string | null }>;
  const hostingUrl = liveUrlFromResources(rows);
  if (!hostingUrl || (await oldFlowBuildUnshipped(db, tenantId))) return null;
  const url = publishUrlFromResources(rows, hostingUrl) ?? hostingUrl;
  const { data: builds } = await db
    .from("conductor_runs")
    .select("id, objective")
    .eq("tenant_id", tenantId)
    .eq("kind", "build_app")
    .eq("status", "done")
    .or("goal_graph->0->payload->>refine_mode.is.null,goal_graph->0->payload->>refine_mode.neq.true")
    .is("goal_graph->0->payload->>site_id", null)
    .is("goal_graph->1->payload->>site_id", null)
    .is("goal_graph->2->payload->>site_id", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const build = ((builds ?? []) as Array<{ id?: string; objective?: string | null }>)[0] ?? null;
  let name = siteNameFromObjective(build?.objective);
  if (!name) {
    const { data: tenant } = await db.from("tenants").select("display_name").eq("id", tenantId).maybeSingle();
    name = ((tenant as { display_name?: string | null } | null)?.display_name ?? "").trim() || "Your app";
  }
  const hosting = rows.find((r) => r.resource_kind === "hosting" && r.status === "ready");
  return {
    name,
    hostname: hostnameOf(url),
    live_url: url,
    build_run_id: typeof build?.id === "string" ? build.id : null,
    updated_at: hosting?.updated_at ?? null,
  };
}
