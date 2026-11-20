
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { serverClientFromBearer } from "@/services/supabase";
import { isInternalHostingUrl, publicUrlOrNull } from "@/services/provisioning/internal-host";
import { isBuiltinHostname } from "@/services/provisioning/builtin-url";
import { buildDatabaseReclaimed } from "@/services/autopilot/build-liveness";

export type LegacyAppRepo = { full_name: string; branch: string };

function safeRepoName(full_name: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(full_name) && !full_name.split("/").some((part) => part === "." || part === "..");
}

export async function readLegacyAppRepo(tenant_id: string): Promise<LegacyAppRepo | null> {
  const { data: row, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_resources")
    .select("mode, external_ref")
    .eq("resource_kind", "repo")
    .maybeSingle();
  if (error) throw new Error(`legacy app repo read failed: ${error.code ?? "unknown"} ${error.message}`);
  const data = row as { mode?: unknown; external_ref?: unknown } | null;
  const ref = (data?.external_ref ?? null) as { github_full_name?: unknown; default_branch?: unknown } | null;
  const full_name = typeof ref?.github_full_name === "string" ? ref.github_full_name : "";
  if (!data || data.mode !== "provisioned" || !safeRepoName(full_name)) return null;
  const branch = typeof ref?.default_branch === "string" && ref.default_branch ? ref.default_branch : "main";
  return { full_name, branch };
}

export { safeRepoName as isSafeRepoName };

export type LegacyAppResourceRow = { resource_kind?: string; status?: string; external_ref?: unknown };

export async function readLegacyAppResources(tenant_id: string): Promise<LegacyAppResourceRow[]> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_resources")
    .select("resource_kind, status, external_ref");
  if (error) throw new Error(`legacy app resources read failed: ${error.code ?? "unknown"} ${error.message}`);
  return (data ?? []) as LegacyAppResourceRow[];
}

function httpsUrlOrNull(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

type SupabaseLike = ReturnType<typeof serverClientFromBearer>;
type LatestBuild = { objective: string | null; status: string; created_at: string; refine_mode: string | null };

export async function loadLatestLegacyBuild(sb: SupabaseLike, tenantId: string): Promise<LatestBuild | null> {
  const { data: recentRuns } = await sb
    .from("conductor_runs")
    .select("objective, status, created_at, refine_mode:goal_graph->0->payload->>refine_mode")
    .eq("tenant_id", tenantId)
    .eq("kind", "build_app")
    .or("goal_graph->0->payload->>refine_mode.is.null,goal_graph->0->payload->>refine_mode.neq.true")
    .is("goal_graph->0->payload->>site_id", null)
    .is("goal_graph->1->payload->>site_id", null)
    .is("goal_graph->2->payload->>site_id", null)
    .order("created_at", { ascending: false })
    .limit(1);
  return ((recentRuns ?? []) as LatestBuild[]).find((run) => run.refine_mode !== "true") ?? null;
}

export async function resolveLegacyAppDeployedUrl(
  sb: SupabaseLike,
  tenantId: string,
  known?: { productUrl: unknown; build: LatestBuild | null },
): Promise<string | null> {
  let productUrlRaw = known?.productUrl;
  let build = known?.build ?? null;
  if (!known) {
    const [{ data: tenant }, latest] = await Promise.all([
      sb.from("tenants").select("product_url").eq("id", tenantId).maybeSingle(),
      loadLatestLegacyBuild(sb, tenantId),
    ]);
    productUrlRaw = (tenant as { product_url?: unknown } | null)?.product_url;
    build = latest;
  }
  const [{ data: domainRow }, { data: customRows }, { data: dbRows, error: dbErr }] = await Promise.all([
    sb.from("tenant_resources").select("external_ref").eq("tenant_id", tenantId).eq("resource_kind", "domain").maybeSingle(),
    sb.from("tenant_custom_domains").select("hostname").eq("tenant_id", tenantId).eq("status", "verified").order("created_at", { ascending: true }).limit(1),
    sb.from("tenant_resources").select("resource_kind, status, updated_at").eq("tenant_id", tenantId).eq("resource_kind", "db"),
  ]);
  const buildRetired = !dbErr && buildDatabaseReclaimed(dbRows, build);
  const domainRef = ((domainRow as { external_ref?: unknown } | null)?.external_ref ?? {}) as Record<string, unknown>;
  const builtinUrl =
    domainRef.status === "live" && typeof domainRef.hostname === "string"
      ? httpsUrlOrNull(`https://${domainRef.hostname}`)
      : null;
  const verifiedCustomHost = (customRows as Array<{ hostname?: string }> | null)?.[0]?.hostname;
  const customDomainUrl =
    typeof verifiedCustomHost === "string" ? httpsUrlOrNull(`https://${verifiedCustomHost}`) : null;

  const productUrl = (productUrlRaw ?? {}) as Record<string, unknown>;
  const marketingUrl = publicUrlOrNull(httpsUrlOrNull(productUrl.marketing));
  return buildRetired
    ? marketingUrl && !new URL(marketingUrl).hostname.endsWith(".onrender.com")
      ? marketingUrl
      : null
    : customDomainUrl ?? builtinUrl ?? marketingUrl;
}

export async function resolveLegacyAppHostUrl(sb: SupabaseLike, tenantId: string): Promise<string | null> {
  const [build, { data: customRows }, { data: resRows, error: resErr }] = await Promise.all([
    loadLatestLegacyBuild(sb, tenantId),
    sb.from("tenant_custom_domains").select("hostname").eq("tenant_id", tenantId).eq("status", "verified").order("created_at", { ascending: true }).limit(1),
    sb.from("tenant_resources").select("resource_kind, status, updated_at, external_ref").eq("tenant_id", tenantId).in("resource_kind", ["db", "domain", "hosting"]),
  ]);
  if (resErr) throw new Error(`tenant_resources read failed: ${resErr.message}`);
  const rows = (resRows ?? []) as Array<{ resource_kind: string; status: string; updated_at?: string | null; external_ref?: Record<string, unknown> | null }>;
  if (buildDatabaseReclaimed(rows, build)) return null;

  const verifiedCustomHost = (customRows as Array<{ hostname?: string }> | null)?.[0]?.hostname;
  const customDomainUrl =
    typeof verifiedCustomHost === "string" ? httpsUrlOrNull(`https://${verifiedCustomHost}`) : null;
  const domainRef = rows.find((r) => r.resource_kind === "domain")?.external_ref ?? {};
  const builtinUrl =
    domainRef.status === "live" && isBuiltinHostname(domainRef.hostname)
      ? httpsUrlOrNull(`https://${String(domainRef.hostname).trim().toLowerCase()}`)
      : null;
  const hosting = rows.find((r) => r.resource_kind === "hosting");
  const hostingUrl = hosting?.status === "ready" ? httpsUrlOrNull(hosting.external_ref?.url) : null;
  const renderUrl = hostingUrl && isInternalHostingUrl(hostingUrl) ? hostingUrl : null;
  return customDomainUrl ?? builtinUrl ?? renderUrl;
}

