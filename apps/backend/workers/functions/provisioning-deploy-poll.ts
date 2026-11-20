
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { getAppSetting } from "@/services/settings";
import { destroySandboxRow } from "@/services/sandbox/lifecycle";
import { requestTicksForTenantBuilds } from "@/services/agents/conductor-kick";

const RENDER = "https://api.render.com";

const PROBE_TIMEOUT_MS = 5000;

const MAX_LIVENESS_ATTEMPTS = 10;

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; method?: string; signal?: AbortSignal },
) => Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export type RenderDeployStatus = string;

export type DeployPollDecision = "awaiting_liveness" | "failed" | "still_provisioning";

const LIVE_STATUSES = new Set<RenderDeployStatus>(["live"]);
const FAILED_STATUSES = new Set<RenderDeployStatus>([
  "build_failed",
  "update_failed",
  "pre_deploy_failed",
  "canceled",
  "deactivated",
]);

export function decideDeployStatus(latestDeployStatus: string | null | undefined): DeployPollDecision {
  if (!latestDeployStatus) return "still_provisioning";
  if (LIVE_STATUSES.has(latestDeployStatus)) return "awaiting_liveness";
  if (FAILED_STATUSES.has(latestDeployStatus)) return "failed";
  return "still_provisioning";
}

type HostingRow = {
  tenant_id: string;
  external_ref: Record<string, unknown> | null;
};

export type DeployPollDeps = {
  loadProvisioningHosting: () => Promise<HostingRow[]>;
  loadRecentFailedHosting?: () => Promise<HostingRow[]>;
  fetchLatestDeployStatus: (serviceId: string) => Promise<string | null>;
  fetchServiceUrl: (serviceId: string) => Promise<string | null>;
  probeLiveness: (url: string) => Promise<boolean>;
  setStatus: (
    tenant_id: string,
    status: "ready" | "failed",
    external_ref: Record<string, unknown>,
  ) => Promise<void>;
  setProductUrl: (tenant_id: string, url: string) => Promise<void>;
  isBuildFlowTenant: (tenant_id: string) => Promise<boolean>;
  bumpProvisioning: (
    tenant_id: string,
    external_ref: Record<string, unknown>,
  ) => Promise<void>;
  swapPreviewOnReady?: (tenant_id: string) => Promise<void>;
  loadPendingSwapTenants?: () => Promise<string[]>;
  kickBuildConductors?: (tenant_id: string) => Promise<unknown>;
};

async function realFetchLatestDeployStatus(
  serviceId: string,
  token: string,
  fetchFn: FetchLike,
): Promise<string | null> {
  const res = await fetchFn(`${RENDER}/v1/services/${serviceId}/deploys?limit=1`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (res.status !== 200) {
    throw new Error(`render deploys list failed (${res.status}): ${await res.text()}`);
  }
  const arr = (await res.json()) as Array<{ deploy?: { status?: string } } | { status?: string }>;
  const first = arr?.[0];
  if (!first) return null;
  const status = ("deploy" in first ? first.deploy?.status : (first as { status?: string }).status) ?? null;
  return status;
}

async function realFetchServiceUrl(
  serviceId: string,
  token: string,
  fetchFn: FetchLike,
): Promise<string | null> {
  const res = await fetchFn(`${RENDER}/v1/services/${serviceId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (res.status !== 200) {
    throw new Error(`render service get failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { serviceDetails?: { url?: string }; service?: { serviceDetails?: { url?: string } } };
  const url = body.serviceDetails?.url ?? body.service?.serviceDetails?.url ?? null;
  return typeof url === "string" && url.length > 0 ? url : null;
}

async function realProbeLiveness(url: string, fetchFn: FetchLike): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { method: "GET", signal: controller.signal });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function realDeployPollDeps(token: string, fetchFn: FetchLike): DeployPollDeps {
  return {
    async loadProvisioningHosting() {
      const { data, error } = await serviceClient()
        .from("tenant_resources")
        .select("tenant_id, external_ref")
        .eq("resource_kind", "hosting")
        .eq("mode", "provisioned")
        .eq("status", "provisioning")
        .limit(200);
      if (error) throw new Error(`tenant_resources hosting select failed: ${error.message}`);
      return (data ?? []) as HostingRow[];
    },
    async loadRecentFailedHosting() {
      const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data, error } = await serviceClient()
        .from("tenant_resources")
        .select("tenant_id, external_ref, updated_at")
        .eq("resource_kind", "hosting")
        .eq("mode", "provisioned")
        .eq("status", "failed")
        .gte("updated_at", sinceIso)
        .limit(50);
      if (error) throw new Error(`tenant_resources failed-hosting select failed: ${error.message}`);
      return (data ?? []) as HostingRow[];
    },
    fetchLatestDeployStatus: (serviceId) => realFetchLatestDeployStatus(serviceId, token, fetchFn),
    fetchServiceUrl: (serviceId) => realFetchServiceUrl(serviceId, token, fetchFn),
    probeLiveness: (url) => realProbeLiveness(url, fetchFn),
    async setStatus(tenant_id, status, external_ref) {
      const { error } = await serviceClient().rpc("set_tenant_resource", {
        p_tenant_id: tenant_id,
        p_resource_kind: "hosting",
        p_mode: "provisioned",
        p_status: status,
        p_provider: "render",
        p_external_ref: external_ref,
        p_vault_key: null,
      });
      if (error) throw new Error(`set_tenant_resource (hosting ${status}) failed: ${error.message}`);
    },
    async isBuildFlowTenant(tenant_id) {
      try {
        const intent = await getAppSetting("build_app_intent", tenant_id);
        return intent === "fresh";
      } catch {
        return false;
      }
    },
    async setProductUrl(tenant_id, url) {
      const { error } = await serviceClient().rpc("set_tenant_company_domain_system", {
        p_tenant_id: tenant_id,
        p_url: url,
        p_source: "provisioned",
        p_source_ref: "render deploy verified live by provisioning-deploy-poll",
      });
      if (error) throw new Error(`set_tenant_company_domain_system failed: ${error.message}`);

      try {
        const { regenerateCompanyBrief } = await import("@/services/company/brief");
        await regenerateCompanyBrief(tenant_id);
      } catch (e) {
        console.warn(
          `[provisioning-deploy-poll] company brief not re-rendered for ${tenant_id}: ${(e as Error).message}`,
        );
      }
    },
    async bumpProvisioning(tenant_id, external_ref) {
      const { error } = await serviceClient().rpc("set_tenant_resource", {
        p_tenant_id: tenant_id,
        p_resource_kind: "hosting",
        p_mode: "provisioned",
        p_status: "provisioning",
        p_provider: "render",
        p_external_ref: external_ref,
        p_vault_key: null,
      });
      if (error) throw new Error(`set_tenant_resource (hosting provisioning bump) failed: ${error.message}`);
    },
    async loadPendingSwapTenants() {
      const svc = serviceClient();
      const { data: previews, error } = await svc
        .from("tenant_sandbox")
        .select("tenant_id")
        .eq("preview_status", "live")
        .is("preview_run_id", null)
        .limit(200);
      if (error) throw new Error(`tenant_sandbox live-preview select failed: ${error.message}`);
      const ids = [...new Set(((previews ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id))];
      if (ids.length === 0) return [];
      const { data: hosting, error: hostingErr } = await svc
        .from("tenant_resources")
        .select("tenant_id")
        .eq("resource_kind", "hosting")
        .eq("mode", "provisioned")
        .eq("status", "ready")
        .in("tenant_id", ids);
      if (hostingErr) throw new Error(`tenant_resources ready-hosting select failed: ${hostingErr.message}`);
      return [...new Set(((hosting ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id))];
    },
    async swapPreviewOnReady(tenant_id) {
      const svc = serviceClient();
      const { data: active, error: activeErr } = await svc
        .from("conductor_runs")
        .select("id")
        .eq("tenant_id", tenant_id)
        .eq("kind", "build_app")
        .in("status", ["active", "provisioning"])
        .limit(1);
      if (activeErr || ((active as unknown[] | null)?.length ?? 0) > 0) return;
      const { data: previews } = await svc
        .from("tenant_sandbox")
        .select("id, preview_run_id")
        .eq("tenant_id", tenant_id)
        .eq("preview_status", "live")
        .limit(50);
      for (const p of selectSwappablePreviews((previews ?? []) as Array<{ id: string; preview_run_id?: string | null }>)) {
        await svc.rpc("clear_sandbox_preview", { p_id: p.id, p_final_status: "swapped" });
        await destroySandboxRow(p.id);
      }
    },
    kickBuildConductors: (tenant_id) => requestTicksForTenantBuilds(inngest, tenant_id),
  };
}

export function selectSwappablePreviews<T extends { id: string; preview_run_id?: string | null }>(rows: T[]): T[] {
  return rows.filter((r) => !r.preview_run_id);
}

async function kickTenantBuilds(
  deps: DeployPollDeps,
  kicked: Set<string>,
  tenant_id: string,
): Promise<void> {
  if (!deps.kickBuildConductors || !tenant_id || kicked.has(tenant_id)) return;
  kicked.add(tenant_id);
  try {
    await deps.kickBuildConductors(tenant_id);
  } catch (e) {
    console.warn(
      `[provisioning-deploy-poll] conductor kick failed for ${tenant_id}: ${(e as Error).message}`,
    );
  }
}

export type DeployPollResult = {
  checked: number;
  ready: number;
  failed: number;
  still_provisioning: number;
  errored: number;
  recovered: number;
};

function readLivenessAttempts(ref: Record<string, unknown> | null | undefined): number {
  const n = ref?.liveness_attempts;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
}

async function reconcileRow(
  deps: DeployPollDeps,
  row: HostingRow,
  serviceId: string,
): Promise<"ready" | "failed" | "still_provisioning"> {
  const baseRef = row.external_ref ?? {};
  const status = await deps.fetchLatestDeployStatus(serviceId);
  const decision = decideDeployStatus(status);

  if (decision === "failed") {
    await deps.setStatus(row.tenant_id, "failed", {
      ...baseRef,
      last_error: "render deploy failed/canceled",
    });
    return "failed";
  }

  if (decision === "still_provisioning") {
    return "still_provisioning";
  }

  const url = await deps.fetchServiceUrl(serviceId);
  const live = url ? await deps.probeLiveness(url) : false;

  if (url && live) {
    await deps.setStatus(row.tenant_id, "ready", { ...baseRef, url });

    try {
      if (await deps.isBuildFlowTenant(row.tenant_id)) {
        await deps.setProductUrl(row.tenant_id, url);
      }
    } catch (e) {
      console.warn(
        `[provisioning-deploy-poll] hosting ready for ${row.tenant_id} but product_url write failed: ${(e as Error).message}`,
      );
    }
    if (deps.swapPreviewOnReady) {
      try {
        await deps.swapPreviewOnReady(row.tenant_id);
      } catch {
      }
    }
    return "ready";
  }

  const attempts = readLivenessAttempts(baseRef) + 1;
  if (attempts >= MAX_LIVENESS_ATTEMPTS) {
    await deps.setStatus(row.tenant_id, "failed", {
      ...baseRef,
      ...(url ? { url } : {}),
      liveness_attempts: attempts,
      last_error: "deploy reported live but the app never served a 2xx within the liveness window",
    });
    return "failed";
  }
  await deps.bumpProvisioning(row.tenant_id, {
    ...baseRef,
    ...(url ? { url } : {}),
    liveness_attempts: attempts,
  });
  return "still_provisioning";
}

export async function reconcileFailedRow(
  deps: DeployPollDeps,
  row: HostingRow,
  serviceId: string,
): Promise<boolean> {
  const baseRef = row.external_ref ?? {};
  const url = await deps.fetchServiceUrl(serviceId);
  const live = url ? await deps.probeLiveness(url) : false;
  if (url && live) {
    await deps.setStatus(row.tenant_id, "ready", {
      ...baseRef,
      url,
      recovered_from_failed: true,
    });
    return true;
  }
  return false;
}

export async function pollDeployStatuses(deps: DeployPollDeps): Promise<DeployPollResult> {
  const rows = await deps.loadProvisioningHosting();
  const result: DeployPollResult = {
    checked: 0,
    ready: 0,
    failed: 0,
    still_provisioning: 0,
    errored: 0,
    recovered: 0,
  };
  const kicked = new Set<string>();
  const swapAttempted = new Set<string>();
  for (const row of rows) {
    const serviceId = String(row.external_ref?.render_service_id ?? "");
    if (!serviceId) continue;
    result.checked++;
    try {
      const outcome = await reconcileRow(deps, row, serviceId);
      if (outcome === "ready") {
        result.ready++;
        swapAttempted.add(row.tenant_id);
      }
      else if (outcome === "failed") result.failed++;
      else result.still_provisioning++;
      if (outcome !== "still_provisioning") await kickTenantBuilds(deps, kicked, row.tenant_id);
    } catch {
      result.errored++;
    }
  }

  if (deps.loadPendingSwapTenants && deps.swapPreviewOnReady) {
    try {
      for (const tenant_id of await deps.loadPendingSwapTenants()) {
        if (swapAttempted.has(tenant_id)) continue;
        swapAttempted.add(tenant_id);
        try {
          await deps.swapPreviewOnReady(tenant_id);
        } catch (e) {
          console.warn(`[provisioning-deploy-poll] deferred preview swap failed for ${tenant_id}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      console.warn(`[provisioning-deploy-poll] deferred preview swap sweep failed: ${(e as Error).message}`);
    }
  }

  if (process.env.BUILD_DEPLOY_STAGE_ENABLED !== "0" && deps.loadRecentFailedHosting) {
    const failedRows = await deps.loadRecentFailedHosting();
    for (const row of failedRows) {
      const serviceId = String(row.external_ref?.render_service_id ?? "");
      if (!serviceId) continue;
      try {
        const recovered = await reconcileFailedRow(deps, row, serviceId);
        if (recovered) {
          result.recovered++;
          await kickTenantBuilds(deps, kicked, row.tenant_id);
        }
      } catch {
        result.errored++;
      }
    }
  }

  return result;
}

export const provisioningDeployPollFn = inngest.createFunction(
  { id: "provisioning-deploy-poll", concurrency: 1 },
  { cron: "*/5 * * * *" },
  async ({ logger }) => {
    const token = process.env.RENDER_API_KEY ?? null;
    if (!token) {
      return { skipped: true, reason: "no_render_api_key" };
    }
    const fetchFn = (globalThis as { fetch: FetchLike }).fetch;
    const result = await pollDeployStatuses(realDeployPollDeps(token, fetchFn));
    if (result.checked > 0) {
      logger.info(
        `provisioning-deploy-poll: checked ${result.checked} — ` +
          `${result.ready} live+serving→ready, ${result.failed} failed, ` +
          `${result.still_provisioning} still building, ${result.errored} errored`,
      );
    }
    return result;
  },
);
