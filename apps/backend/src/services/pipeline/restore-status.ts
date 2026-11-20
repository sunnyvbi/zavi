import { asTenantId, tenantClient } from "@/services/tenant-client";

const RENDER = "https://api.render.com";

export const RESTORE_COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

const FAILED_DEPLOY_STATUSES = new Set([
  "build_failed",
  "update_failed",
  "canceled",
  "deactivated",
  "pre_deploy_failed",
]);

export type RestoreState = "deploying" | "live" | "failed" | "unknown";

export type RestoreStatus = {
  state: RestoreState;
  served_sha: string | null;
  deploy_status: string | null;
};

export type RenderDeployItem = {
  id: string | null;
  status: string;
  commit_sha: string | null;
};

export type RestoreStatusDeps = {
  loadHostingServiceId(tenant_id: string): Promise<string | null>;
  renderToken(): string | null;
  listDeploys(serviceId: string, token: string): Promise<RenderDeployItem[]>;
};

const UNKNOWN: RestoreStatus = { state: "unknown", served_sha: null, deploy_status: null };

export function classifyRestoreDeploys(
  deploys: RenderDeployItem[],
  commitSha: string,
): RestoreStatus {
  const wanted = commitSha.toLowerCase();
  const served = deploys.find((d) => d.status === "live");
  const served_sha = served?.commit_sha ?? null;
  const match = deploys.find(
    (d) => typeof d.commit_sha === "string" && d.commit_sha.toLowerCase().startsWith(wanted),
  );
  if (!match) return { state: "deploying", served_sha, deploy_status: null };
  if (match.status === "live") {
    return { state: "live", served_sha: match.commit_sha, deploy_status: match.status };
  }
  if (FAILED_DEPLOY_STATUSES.has(match.status)) {
    return { state: "failed", served_sha, deploy_status: match.status };
  }
  return { state: "deploying", served_sha, deploy_status: match.status };
}

export async function getRestoreStatus(
  tenant_id: string,
  commit_sha: string,
  deps: RestoreStatusDeps = realRestoreStatusDeps,
): Promise<RestoreStatus> {
  if (!RESTORE_COMMIT_SHA_RE.test(commit_sha)) return UNKNOWN;
  try {
    const token = deps.renderToken();
    if (!token) return UNKNOWN;
    const serviceId = await deps.loadHostingServiceId(tenant_id);
    if (!serviceId) return UNKNOWN;
    const deploys = await deps.listDeploys(serviceId, token);
    return classifyRestoreDeploys(deploys, commit_sha);
  } catch {
    return UNKNOWN;
  }
}

export async function realLoadHostingServiceId(tenant_id: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_resources")
    .select("external_ref")
    .eq("tenant_id", tenant_id)
    .eq("resource_kind", "hosting")
    .eq("mode", "provisioned")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`tenant_resources hosting read failed: ${error.message}`);
  const ref = (data as Array<{ external_ref?: Record<string, unknown> | null }> | null)?.[0]
    ?.external_ref;
  const id = ref?.render_service_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function realListDeploys(
  serviceId: string,
  token: string,
): Promise<RenderDeployItem[]> {
  const res = await fetch(`${RENDER}/v1/services/${encodeURIComponent(serviceId)}/deploys?limit=10`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (res.status !== 200) throw new Error(`render deploys list failed (${res.status})`);
  type Raw = { id?: unknown; status?: unknown; commit?: { id?: unknown } | null };
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) return [];
  const out: RenderDeployItem[] = [];
  for (const item of body as Array<{ deploy?: Raw } | Raw>) {
    if (!item || typeof item !== "object") continue;
    const d = "deploy" in item && item.deploy && typeof item.deploy === "object" ? item.deploy : (item as Raw);
    if (typeof d.status !== "string" || d.status.length === 0) continue;
    out.push({
      id: typeof d.id === "string" ? d.id : null,
      status: d.status,
      commit_sha: typeof d.commit?.id === "string" ? d.commit.id : null,
    });
  }
  return out;
}

export const realRestoreStatusDeps: RestoreStatusDeps = {
  loadHostingServiceId: realLoadHostingServiceId,
  renderToken: () => process.env.RENDER_API_KEY ?? null,
  listDeploys: realListDeploys,
};
