
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { destroySandboxRow } from "@/services/sandbox/lifecycle";
import { destroySandbox, listSandboxes, type ListedSandbox } from "@/services/sandbox/e2b-client";
import { isResourceReapable } from "@/services/provisioning/reapable-guard";
import { reaperAllowedInEnv, reaperEnabledFromEnv } from "@/services/provisioning/reaper-env-scope";
import { getProvisioner } from "@/services/provisioning/registry";
import { registerBuiltinProvisioners } from "@/services/provisioning";
import type { ResourceKind } from "@/services/provisioning/types";

const ABANDONED_DAYS = 7;
export const PREVIEW_IDLE_MIN = 15;
const MAX_SANDBOXES_PER_RUN = 50;
const MAX_INFRA_PER_RUN = 50;
export const PREVIEW_AGENT_SLUGS = ["engineer"] as const;
export const BUSY_RUN_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function buildOrgPrefixes(): string[] {
  const configured = (process.env.PRAXIS_GITHUB_ORG ?? "praxis-built").toLowerCase();
  return [...new Set([configured, "praxis-built", "praxis-build"])];
}

export function isBuildRepo(repo_full_name: string | null | undefined): boolean {
  if (!repo_full_name || typeof repo_full_name !== "string") return false;
  const owner = repo_full_name.split("/")[0]?.toLowerCase() ?? "";
  return buildOrgPrefixes().includes(owner);
}

export function enabled(): boolean {
  return reaperEnabledFromEnv();
}

export type SandboxReapRow = {
  id: string;
  tenant_id: string | null;
  repo_full_name: string;
  e2b_sandbox_id: string | null;
  status: string;
  updated_at: string;
  preview_status?: string | null;
  preview_last_viewed_at?: string | null;
};

export type PreviewReapDecision = {
  row_id: string;
  e2b_sandbox_id: string | null;
  reap: boolean;
  reason: string;
};

export function decidePreviewIdleReap(
  row: SandboxReapRow,
  now: number,
): PreviewReapDecision {
  const base = { row_id: row.id, e2b_sandbox_id: row.e2b_sandbox_id };
  if (row.preview_status !== "live") {
    return { ...base, reap: false, reason: "not_a_live_preview" };
  }
  const anchor = row.preview_last_viewed_at ?? row.updated_at;
  const idleMs = now - new Date(anchor).getTime();
  if (idleMs > PREVIEW_IDLE_MIN * 60 * 1000) {
    return { ...base, reap: true, reason: `preview_idle_${PREVIEW_IDLE_MIN}min` };
  }
  return { ...base, reap: false, reason: "preview_viewed_recently" };
}

export type SandboxReapDecision = {
  row_id: string;
  e2b_sandbox_id: string | null;
  reap: boolean;
  reason: string;
};

export function decideSandboxReap(
  row: SandboxReapRow,
  tenantAlive: boolean,
  tenantSlug: string | null,
  now: number,
): SandboxReapDecision {
  const base = { row_id: row.id, e2b_sandbox_id: row.e2b_sandbox_id };

  if (!isBuildRepo(row.repo_full_name)) {
    return { ...base, reap: false, reason: "not_a_build_repo" };
  }

  const verdict = isResourceReapable({
    tenantId: row.tenant_id,
    tenantAlive,
    tenantSlug,
    status: row.status,
  });
  if (!verdict.reapable) {
    return { ...base, reap: false, reason: "protected_live_customer" };
  }

  const status = (row.status ?? "").toLowerCase();
  const ageMs = now - new Date(row.updated_at).getTime();
  const staleEnough = ageMs > ABANDONED_DAYS * 24 * 60 * 60 * 1000;

  if (status === "active" || status === "creating") {
    return { ...base, reap: false, reason: "in_use" };
  }
  if (status === "destroyed") {
    return row.e2b_sandbox_id
      ? { ...base, reap: true, reason: `${verdict.reason}+destroyed_row` }
      : { ...base, reap: false, reason: "already_destroyed" };
  }
  if ((status === "paused" || status === "failed") && staleEnough) {
    return { ...base, reap: true, reason: `${verdict.reason}+stale_${status}` };
  }
  return { ...base, reap: false, reason: `${status}_not_stale` };
}

export type OrphanSandboxDecision = { sandbox_id: string; reap: boolean; reason: string };

const SITE_GATE_SANDBOX_PREFIX = "site-gate:";
const SITE_GATE_SANDBOX_MAX_AGE_MS = 30 * 60 * 1000;

export function decideOrphanSandbox(
  sb: ListedSandbox,
  knownSandboxIds: Set<string>,
  now: number = Date.now(),
): OrphanSandboxDecision {
  if (knownSandboxIds.has(sb.sandbox_id)) {
    return { sandbox_id: sb.sandbox_id, reap: false, reason: "tracked_by_db" };
  }
  const repo = sb.metadata?.repo;
  if (repo?.startsWith(SITE_GATE_SANDBOX_PREFIX)) {
    const age = now - new Date(sb.started_at).getTime();
    return age > SITE_GATE_SANDBOX_MAX_AGE_MS
      ? { sandbox_id: sb.sandbox_id, reap: true, reason: "orphan_site_gate" }
      : { sandbox_id: sb.sandbox_id, reap: false, reason: "site_gate_in_flight" };
  }
  if (repo && !isBuildRepo(repo)) {
    return { sandbox_id: sb.sandbox_id, reap: false, reason: "connected_repo" };
  }
  return { sandbox_id: sb.sandbox_id, reap: true, reason: "orphan_no_db_row" };
}

export type InfraResourceRow = {
  tenant_id: string | null;
  resource_kind: string;
  mode: string;
  status: string;
  external_ref: Record<string, unknown> | null;
};

export type InfraReapDecision = {
  tenant_id: string | null;
  resource_kind: string;
  reap: boolean;
  reason: string;
};

export function decideInfraReap(
  row: InfraResourceRow,
  tenantAlive: boolean,
  tenantSlug: string | null,
  tenantAbandoned: boolean,
): InfraReapDecision {
  const base = { tenant_id: row.tenant_id, resource_kind: row.resource_kind };

  if (row.mode !== "provisioned") {
    return { ...base, reap: false, reason: "connected_mode" };
  }

  const verdict = isResourceReapable({
    tenantId: row.tenant_id,
    tenantAlive,
    tenantSlug,
    status: row.status,
  });
  if (!verdict.reapable) {
    return { ...base, reap: false, reason: "protected_live_customer" };
  }

  const status = (row.status ?? "").toLowerCase();
  if (status === "torn_down") {
    return { ...base, reap: false, reason: "already_torn_down" };
  }
  if (status === "failed" || status === "teardown" || status === "deprovisioning") {
    return { ...base, reap: true, reason: `${verdict.reason}+${status}` };
  }
  if (verdict.reason === "tenant_deleted" || verdict.reason === "orphaned_no_tenant") {
    return { ...base, reap: true, reason: verdict.reason };
  }
  if (verdict.reason === "throwaway_tenant" && tenantAbandoned) {
    return { ...base, reap: true, reason: "throwaway_tenant+abandoned" };
  }
  return { ...base, reap: false, reason: `${status}_kept` };
}

export function mergeTeardownRef(
  row: InfraResourceRow,
  siblingRefs: Record<string, unknown>,
): Record<string, unknown> {
  return { ...siblingRefs, ...(row.external_ref ?? {}) };
}

type TenantMeta = { alive: boolean; slug: string | null; abandoned: boolean };

async function loadTenantMeta(tenantIds: string[]): Promise<Map<string, TenantMeta>> {
  const sb = serviceClient();
  const out = new Map<string, TenantMeta>();
  if (tenantIds.length === 0) return out;

  const { data: tenants } = await sb
    .from("tenants")
    .select("id, slug")
    .in("id", tenantIds);
  const slugById = new Map<string, string | null>(
    (tenants ?? []).map((t: { id: string; slug: string | null }) => [t.id, t.slug ?? null]),
  );

  const since = new Date(Date.now() - ABANDONED_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentRuns } = await sb
    .from("agent_runs")
    .select("tenant_id")
    .in("tenant_id", tenantIds)
    .gte("enqueued_at", since)
    .limit(5000);
  const activeTenantIds = new Set<string>((recentRuns ?? []).map((r: { tenant_id: string }) => r.tenant_id));

  for (const id of tenantIds) {
    const alive = slugById.has(id);
    out.set(id, {
      alive,
      slug: slugById.get(id) ?? null,
      abandoned: !alive || !activeTenantIds.has(id),
    });
  }
  return out;
}

export async function loadBusyTenants(
  sb: ReturnType<typeof serviceClient>,
  tenantIds: string[],
): Promise<Set<string>> {
  if (tenantIds.length === 0) return new Set();
  try {
    const runCutoff = new Date(Date.now() - BUSY_RUN_MAX_AGE_MS).toISOString();
    const [runs, conductors] = await Promise.all([
      sb
        .from("agent_runs")
        .select("tenant_id")
        .in("tenant_id", tenantIds)
        .eq("status", "running")
        .in("agent_slug", [...PREVIEW_AGENT_SLUGS])
        .gte("started_at", runCutoff)
        .limit(5000),
      sb
        .from("conductor_runs")
        .select("tenant_id")
        .in("tenant_id", tenantIds)
        .eq("kind", "build_app")
        .in("status", ["active", "provisioning"])
        .limit(5000),
    ]);
    if (runs.error || conductors.error) return new Set(tenantIds);
    const rows = [...(runs.data ?? []), ...(conductors.data ?? [])] as Array<{ tenant_id: string | null }>;
    return new Set(rows.map((r) => r.tenant_id).filter((x): x is string => !!x));
  } catch {
    return new Set(tenantIds);
  }
}

export async function sweepSandboxes(dryRun: boolean, logger: { info: (m: string) => void }): Promise<{
  candidates: number;
  reaped: number;
  errors: number;
}> {
  const sb = serviceClient();
  const { data: rows, error } = await sb
    .from("tenant_sandbox")
    .select("id, tenant_id, repo_full_name, e2b_sandbox_id, status, updated_at, preview_status, preview_last_viewed_at")
    .in("status", ["paused", "failed", "destroyed"])
    .limit(2000);
  if (error) {
    logger.info(`infra-reaper: tenant_sandbox select failed: ${error.message}`);
    return { candidates: 0, reaped: 0, errors: 1 };
  }
  const sandboxRows = (rows ?? []) as SandboxReapRow[];

  const tenantIds = [...new Set(sandboxRows.map((r) => r.tenant_id).filter((x): x is string => !!x))];
  const meta = await loadTenantMeta(tenantIds);
  const now = Date.now();

  const toReap = sandboxRows
    .map((row) => {
      const m = row.tenant_id ? meta.get(row.tenant_id) : undefined;
      return decideSandboxReap(row, m?.alive ?? false, m?.slug ?? null, now);
    })
    .filter((d) => d.reap)
    .slice(0, MAX_SANDBOXES_PER_RUN);

  const { data: previewRows } = await sb
    .from("tenant_sandbox")
    .select("id, tenant_id, repo_full_name, e2b_sandbox_id, status, updated_at, preview_status, preview_last_viewed_at")
    .eq("status", "active")
    .eq("preview_status", "live")
    .is("preview_run_id", null)
    .limit(500);
  const idlePreviews = ((previewRows ?? []) as SandboxReapRow[])
    .map((row) => ({ row, d: decidePreviewIdleReap(row, now) }))
    .filter(({ d }) => d.reap);
  const busyTenants = await loadBusyTenants(
    sb,
    [...new Set(idlePreviews.map(({ row }) => row.tenant_id).filter((x): x is string => !!x))],
  );
  const previewToReap = idlePreviews
    .filter(({ row }) => !row.tenant_id || !busyTenants.has(row.tenant_id))
    .map(({ d }) => d)
    .slice(0, MAX_SANDBOXES_PER_RUN);

  const { data: allRows } = await sb
    .from("tenant_sandbox")
    .select("e2b_sandbox_id, status")
    .not("e2b_sandbox_id", "is", null)
    .in("status", ["creating", "active", "paused", "failed"])
    .limit(5000);
  const knownIds = new Set<string>(
    (allRows ?? [])
      .map((r: { e2b_sandbox_id: string | null }) => r.e2b_sandbox_id)
      .filter((x): x is string => !!x),
  );

  let reaped = 0;
  let errors = 0;
  for (const d of toReap) {
    logger.info(`infra-reaper: ${dryRun ? "DRY would reap" : "reaping"} sandbox row=${d.row_id} reason=${d.reason}`);
    if (dryRun) continue;
    try {
      await destroySandboxRow(d.row_id);
      reaped += 1;
    } catch (e) {
      errors += 1;
      logger.info(`infra-reaper: destroySandboxRow ${d.row_id} failed: ${(e as Error).message}`);
    }
  }

  for (const d of previewToReap) {
    logger.info(
      `infra-reaper: ${dryRun ? "DRY would reap idle preview" : "reaping idle preview"} ` +
        `row=${d.row_id} reason=${d.reason}`,
    );
    if (dryRun) continue;
    try {
      await sb.rpc("clear_sandbox_preview", { p_id: d.row_id, p_final_status: "dead" });
      await destroySandboxRow(d.row_id);
      reaped += 1;
    } catch (e) {
      errors += 1;
      logger.info(`infra-reaper: idle-preview reap ${d.row_id} failed: ${(e as Error).message}`);
    }
  }

  let orphanCandidates = 0;
  const listed = await listSandboxes();
  for (const s of listed) {
    const od = decideOrphanSandbox(s, knownIds);
    if (!od.reap) continue;
    orphanCandidates += 1;
    if (reaped >= MAX_SANDBOXES_PER_RUN) break;
    logger.info(`infra-reaper: ${dryRun ? "DRY would kill" : "killing"} orphan e2b ${s.sandbox_id} reason=${od.reason}`);
    if (dryRun) continue;
    try {
      await destroySandbox(s.sandbox_id);
      reaped += 1;
    } catch (e) {
      errors += 1;
      logger.info(`infra-reaper: orphan kill ${s.sandbox_id} failed: ${(e as Error).message}`);
    }
  }

  return { candidates: toReap.length + previewToReap.length + orphanCandidates, reaped, errors };
}

async function teardownInfra(dryRun: boolean, logger: { info: (m: string) => void }): Promise<{
  candidates: number;
  torn_down: number;
  errors: number;
}> {
  registerBuiltinProvisioners();
  const sb = serviceClient();
  const { data: rows, error } = await sb
    .from("tenant_resources")
    .select("tenant_id, resource_kind, mode, status, external_ref")
    .eq("mode", "provisioned")
    .limit(2000);
  if (error) {
    logger.info(`infra-reaper: tenant_resources select failed: ${error.message}`);
    return { candidates: 0, torn_down: 0, errors: 1 };
  }
  const resourceRows = (rows ?? []) as InfraResourceRow[];
  const tenantIds = [...new Set(resourceRows.map((r) => r.tenant_id).filter((x): x is string => !!x))];
  const meta = await loadTenantMeta(tenantIds);

  const siblingByTenant = new Map<string, Record<string, unknown>>();
  for (const r of resourceRows) {
    if (!r.tenant_id || !r.external_ref) continue;
    const cur = siblingByTenant.get(r.tenant_id) ?? {};
    siblingByTenant.set(r.tenant_id, { ...cur, ...r.external_ref });
  }

  const decisions = resourceRows
    .map((row) => {
      const m = row.tenant_id ? meta.get(row.tenant_id) : undefined;
      return { row, d: decideInfraReap(row, m?.alive ?? false, m?.slug ?? null, m?.abandoned ?? true) };
    })
    .filter((x) => x.d.reap)
    .slice(0, MAX_INFRA_PER_RUN);

  let tornDown = 0;
  let errors = 0;
  for (const { row, d } of decisions) {
    logger.info(
      `infra-reaper: ${dryRun ? "DRY would tear down" : "tearing down"} ${row.resource_kind} ` +
        `tenant=${row.tenant_id} reason=${d.reason}`,
    );
    if (dryRun) continue;
    const provisioner = getProvisioner(row.resource_kind as ResourceKind);
    if (!provisioner) {
      logger.info(`infra-reaper: no provisioner for kind=${row.resource_kind}; skipping`);
      continue;
    }
    const ref = mergeTeardownRef(row, row.tenant_id ? siblingByTenant.get(row.tenant_id) ?? {} : {});
    try {
      await provisioner.teardown(ref);
      if (row.tenant_id) {
        await sb
          .from("tenant_resources")
          .update({ status: "torn_down", updated_at: new Date().toISOString() })
          .eq("tenant_id", row.tenant_id)
          .eq("resource_kind", row.resource_kind);
      }
      tornDown += 1;
    } catch (e) {
      errors += 1;
      logger.info(`infra-reaper: teardown ${row.resource_kind} tenant=${row.tenant_id} failed: ${(e as Error).message}`);
    }
  }

  return { candidates: decisions.length, torn_down: tornDown, errors };
}

export const infraReaperFn = inngest.createFunction(
  { id: "infra-reaper", concurrency: { limit: 1, key: '"global"' } },
  { cron: "40 4 * * *" },
  async ({ logger }) => {
    const envScope = reaperAllowedInEnv();
    if (!envScope.allowed) {
      logger.warn(`infra-reaper: skipped — ${envScope.reason}`);
      return { ok: true, skipped: "env_scope_guard", reason: envScope.reason };
    }
    const dryRun = !enabled();
    if (dryRun) {
      logger.info("infra-reaper: DRY-RUN (INFRA_REAPER_ENABLED='0' kill-switch) — computing candidates, issuing zero deletes");
    }
    const sandboxes = await sweepSandboxes(dryRun, logger);
    const infra = await teardownInfra(dryRun, logger);
    logger.info(
      `infra-reaper: sandboxes ${sandboxes.reaped}/${sandboxes.candidates} reaped · ` +
        `infra ${infra.torn_down}/${infra.candidates} torn down · ` +
        `errors=${sandboxes.errors + infra.errors} · dryRun=${dryRun}`,
    );
    return { ok: true, dryRun, sandboxes, infra };
  },
);
