
import { isResourceReapable } from "@/services/provisioning/reapable-guard";
import { reaperAllowedInEnv, reaperEnabledFromEnv, type ReaperScopeResult } from "@/services/provisioning/reaper-env-scope";
import { asTenantId, sitePublicRpc, tenantClient, tenantRpc } from "@/services/tenant-client";
import type { SiteStatus } from "./contract";
import { realSiteTeardownDeps, teardownSiteProviders, type SiteTeardownDeps } from "./teardown";

export const SITE_REAPER_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export const SITE_REAPED_FAILED = "Cleaned up 24 hours after the build failed.";
export const SITE_REAPED_STRANDED = "Cleaned up: the build stopped while setting up this site.";

function isReapedSite(site: { status: SiteStatus; last_error?: string | null }): boolean {
  if (site.status === "failed") return true;
  return site.status === "deleting" && (site.last_error === SITE_REAPED_FAILED || site.last_error === SITE_REAPED_STRANDED);
}
export const SITE_REAPER_MAX_PER_RUN = 25;

const DEAD: ReadonlySet<SiteStatus> = new Set<SiteStatus>(["fell_back_old", "failed", "deleting", "deleted"]);
const STRANDED: ReadonlySet<SiteStatus> = new Set<SiteStatus>(["provisioning", "building"]);
const LIVE_RUN = new Set(["provisioning", "active", "paused"]);

export type SiteRunState = "live" | "done" | "dead";

export type SiteReaperCandidate = { tenant_id: string; site_id: string; status: SiteStatus; tenant_slug: string | null };

export type SiteReaperDeps = {
  candidates: (cutoff_iso: string, limit: number) => Promise<SiteReaperCandidate[]>;
  teardown: SiteTeardownDeps;
  runState?: (tenant_id: string, conductor_run_id: string | null) => Promise<SiteRunState>;
  claimStranded?: (tenant_id: string, site_id: string, cutoff_iso: string, last_error: string) => Promise<boolean>;
  claimFailed?: (tenant_id: string, site_id: string, cutoff_iso: string, last_error: string) => Promise<boolean>;
  enabled: () => boolean;
  envScope: () => ReaperScopeResult;
  now: () => Date;
};

export type SiteReaperResult = {
  dry_run: boolean;
  scanned: number;
  reaped: string[];
  pending: string[];
  skipped: Array<{ site_id: string; reason: string }>;
  refused?: string;
};

async function realCandidates(cutoff_iso: string, limit: number): Promise<SiteReaperCandidate[]> {
  const { data, error } = await sitePublicRpc("site_reaper_candidates", { p_cutoff: cutoff_iso, p_limit: limit });
  if (error) throw new Error(`site_reaper_candidates failed: ${error.message}`);
  return ((Array.isArray(data) ? data : []) as Array<Partial<SiteReaperCandidate>>)
    .filter((r) => r?.tenant_id && r.site_id && r.status)
    .map((r) => ({ tenant_id: r.tenant_id!, site_id: r.site_id!, status: r.status as SiteStatus, tenant_slug: r.tenant_slug ?? null }));
}

async function realRunState(tenant_id: string, conductor_run_id: string | null): Promise<SiteRunState> {
  if (!conductor_run_id) return "dead";
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("conductor_runs")
    .select("status")
    .eq("id", conductor_run_id)
    .maybeSingle();
  if (error) throw new Error(`conductor_runs read failed: ${error.message}`);
  const status = (data as { status?: unknown } | null)?.status;
  if (typeof status !== "string") return "dead";
  if (LIVE_RUN.has(status)) return "live";
  return status === "done" ? "done" : "dead";
}

async function realClaimStranded(tenant_id: string, site_id: string, cutoff_iso: string, last_error: string): Promise<boolean> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "site_claim_stranded", {
    p_site_id: site_id,
    p_cutoff: cutoff_iso,
    p_last_error: last_error,
  });
  if (error) throw new Error(`site_claim_stranded failed: ${error.message}`);
  return data === true;
}

async function realClaimFailed(tenant_id: string, site_id: string, cutoff_iso: string, last_error: string): Promise<boolean> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "site_claim_failed", {
    p_site_id: site_id,
    p_cutoff: cutoff_iso,
    p_last_error: last_error,
  });
  if (error) throw new Error(`site_claim_failed failed: ${error.message}`);
  return data === true;
}

export function realSiteReaperDeps(): SiteReaperDeps {
  return {
    candidates: realCandidates,
    runState: realRunState,
    claimStranded: realClaimStranded,
    claimFailed: realClaimFailed,
    teardown: realSiteTeardownDeps(),
    enabled: () => reaperEnabledFromEnv(),
    envScope: () => reaperAllowedInEnv(),
    now: () => new Date(),
  };
}

function guardStatus(status: SiteStatus): string {
  return DEAD.has(status) || STRANDED.has(status) ? "teardown" : status;
}

export async function reapSites(deps: SiteReaperDeps = realSiteReaperDeps()): Promise<SiteReaperResult> {
  const dry_run = !deps.enabled();
  const out: SiteReaperResult = { dry_run, scanned: 0, reaped: [], pending: [], skipped: [] };
  const scope = deps.envScope();
  if (!scope.allowed) return { ...out, refused: scope.reason ?? "reaper not allowed in this environment" };

  const cutoff = new Date(deps.now().getTime() - SITE_REAPER_MIN_AGE_MS).toISOString();
  const rows = (await deps.candidates(cutoff, SITE_REAPER_MAX_PER_RUN)).slice(0, SITE_REAPER_MAX_PER_RUN);
  out.scanned = rows.length;

  for (const r of rows) {
    let teardownSite: { tenant_id: string; site_id: string; from_status: SiteStatus } | null = null;
    try {
      const site = await deps.teardown.store.get(r.tenant_id, r.site_id);
      if (!site || site.tenant_id !== r.tenant_id) {
        out.skipped.push({ site_id: r.site_id, reason: "not_found" });
        continue;
      }
      const verdict = isResourceReapable({
        tenantId: site.tenant_id,
        tenantAlive: true,
        tenantSlug: r.tenant_slug,
        status: guardStatus(site.status),
      });
      const stranded = STRANDED.has(site.status);
      if ((stranded || site.status === "failed") && site.live_deploy_id) {
        if (!dry_run) await deps.teardown.store.transition(site.tenant_id, site.id, [site.status], "live");
        out.skipped.push({ site_id: site.id, reason: "serving" });
        continue;
      }
      if ((!DEAD.has(site.status) && !stranded) || !verdict.reapable) {
        out.skipped.push({ site_id: site.id, reason: DEAD.has(site.status) || stranded ? verdict.reason : `status_${site.status}` });
        continue;
      }
      const abandoned = stranded || site.status === "failed";
      if (abandoned) {
        if (site.live_sha || site.live_deploy_id) {
          console.warn(JSON.stringify({ evt: "site_reaper_refused", tenant_id: site.tenant_id, site_id: site.id, status: site.status, reason: "has_live_deploy" }));
          out.skipped.push({ site_id: site.id, reason: "has_live_deploy" });
          continue;
        }
        const updated = Date.parse(site.updated_at);
        if (!Number.isFinite(updated) || updated >= Date.parse(cutoff)) {
          out.skipped.push({ site_id: site.id, reason: stranded ? "stranded_too_young" : "failed_too_young" });
          continue;
        }
        if (!deps.runState) {
          out.skipped.push({ site_id: site.id, reason: "run_check_unavailable" });
          continue;
        }
        const runState = await deps.runState(site.tenant_id, site.root_conductor_run_id);
        if (runState === "live") {
          out.skipped.push({ site_id: site.id, reason: "run_live" });
          continue;
        }
        if (runState === "done" && site.status === "building") {
          out.skipped.push({ site_id: site.id, reason: "build_finished" });
          continue;
        }
        if (runState !== "dead" && runState !== "done") {
          out.skipped.push({ site_id: site.id, reason: "run_check_unavailable" });
          continue;
        }
      }
      if (dry_run) {
        console.log(JSON.stringify({ evt: "site_reaper_teardown", tenant_id: site.tenant_id, site_id: site.id, from_status: site.status, outcome: "dry_run" }));
        continue;
      }
      let current = site;
      const atomicClaim = stranded ? deps.claimStranded : site.status === "failed" ? deps.claimFailed : undefined;
      if (atomicClaim) {
        const claimed = await atomicClaim(site.tenant_id, site.id, cutoff, stranded ? SITE_REAPED_STRANDED : SITE_REAPED_FAILED);
        const moved = claimed ? await deps.teardown.store.get(site.tenant_id, site.id) : null;
        if (!moved || moved.status !== "deleting") {
          out.skipped.push({ site_id: site.id, reason: "status_changed" });
          continue;
        }
        current = moved;
      } else if (stranded || site.status === "failed") {
        const moved = await deps.teardown.store.transition(site.tenant_id, site.id, [site.status], "deleting", {
          last_error: stranded ? SITE_REAPED_STRANDED : SITE_REAPED_FAILED,
        });
        if (!moved) {
          out.skipped.push({ site_id: site.id, reason: "status_changed" });
          continue;
        }
        current = moved;
      }
      teardownSite = { tenant_id: site.tenant_id, site_id: site.id, from_status: site.status };
      console.log(JSON.stringify({ evt: "site_reaper_teardown", ...teardownSite, outcome: "started" }));
      const res = await teardownSiteProviders(site.tenant_id, current, deps.teardown, {
        allowPurge: true,
        repoGrace: isReapedSite(current),
      });
      if (res.complete) {
        if (current.status === "deleting") await deps.teardown.store.transition(site.tenant_id, site.id, ["deleting"], "deleted");
        out.reaped.push(site.id);
      } else {
        out.pending.push(site.id);
      }
      console.log(JSON.stringify({ evt: "site_reaper_teardown", ...teardownSite, outcome: res.complete ? "reaped" : "pending" }));
    } catch (e) {
      const reason = `error: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
      out.skipped.push({ site_id: r.site_id, reason });
      if (teardownSite) console.error(JSON.stringify({ evt: "site_reaper_teardown", ...teardownSite, outcome: "error", reason }));
    }
  }
  return out;
}
