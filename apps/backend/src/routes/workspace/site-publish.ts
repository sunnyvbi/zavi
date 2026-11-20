import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { isProductBuilderEnabled } from "@/agents/engineer/product-builder-flag";
import { realSiteRepublisher, type SiteRepublisher } from "@/services/agents/refine-product";
import { DoubleBuildInFlight, ProvisionBudgetExceeded, TooManyBuildsToday } from "@/services/agents/start-product-build";
import { readProvisionedRepoHead } from "@/services/provisioning/github-repo";
import type { SiteRow, SiteStatus, SiteStore } from "@/services/sites/contract";
import { isVisibleSite } from "@/services/sites/site-build-status";
import { siteStore } from "@/services/sites/store";
import { asTenantId, tenantClient } from "@/services/tenant-client";

const PUBLISH_ROLES = ["owner", "admin", "member"] as const;
const SITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;
const NOT_PUBLISHABLE: ReadonlySet<SiteStatus> = new Set<SiteStatus>(["provisioning", "failed"]);

export type SitePublishDeps = {
  store: Pick<SiteStore, "get">;
  headOf: (github_full_name: string) => Promise<{ sha: string } | { error: string }>;
  republisher: SiteRepublisher;
  discardHeldSlot: (input: { tenant_id: string; conductor_run_id: string }) => Promise<void>;
  rootRunStatus: (tenant_id: string, conductor_run_id: string) => Promise<string | null>;
};

export async function realRootRunStatus(tenant_id: string, conductor_run_id: string): Promise<string | null> {
  const { data, error } = await (tenantClient(asTenantId(tenant_id)).from("conductor_runs").select("status") as any)
    .eq("tenant_id", tenant_id)
    .eq("id", conductor_run_id)
    .maybeSingle();
  if (error) throw new Error(`conductor_runs status read failed: ${error.message ?? "unknown error"}`);
  const status = (data as { status?: unknown } | null)?.status;
  return typeof status === "string" ? status : null;
}

export async function realDiscardPublishSlot(input: { tenant_id: string; conductor_run_id: string }): Promise<void> {
  const { data, error } = await tenantClient(asTenantId(input.tenant_id))
    .from("conductor_runs")
    .update({ kind: "undo", status: "failed", updated_at: new Date().toISOString() })
    .eq("tenant_id", input.tenant_id)
    .eq("id", input.conductor_run_id)
    .eq("kind", "build_app")
    .in("status", ["provisioning", "active"])
    .select("id");
  if (error) throw new Error(`conductor_runs publish slot discard failed: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) throw new Error("conductor_runs publish slot discard matched no held slot");
}

export function realSitePublishDeps(): SitePublishDeps {
  const store = siteStore();
  return {
    store,
    headOf: (github_full_name) => readProvisionedRepoHead(github_full_name, "main"),
    republisher: realSiteRepublisher,
    discardHeldSlot: realDiscardPublishSlot,
    rootRunStatus: realRootRunStatus,
  };
}

export async function postSitePublish(req: Request, res: Response): Promise<void> {
  await handleSitePublish(req, res, realSitePublishDeps());
}

function refuse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function alreadyLiveAt(site: SiteRow, sha: string): boolean {
  return site.status === "live" && !!site.live_deploy_id && site.live_sha?.toLowerCase() === sha && site.desired_sha?.toLowerCase() === sha;
}

const HEAD_UNREADABLE_MESSAGE = "We couldn't read the site's latest version. Nothing was published. Try again in a moment.";
const ALREADY_PUBLISHED_MESSAGE = "The latest version of this site is already published.";
const BUILD_NOT_FINISHED_MESSAGE = "This site's build hasn't finished yet. You can publish once the build is done.";
const BUILD_STATUS_UNREADABLE_MESSAGE = "We couldn't check whether the site's build has finished. Nothing was published. Try again in a moment.";

async function readHeadSha(deps: SitePublishDeps, repo: string, tenant_id: string, site_id: string): Promise<string | null> {
  let why = "invalid sha";
  try {
    const head = await deps.headOf(repo);
    const sha = "sha" in head ? head.sha.trim().toLowerCase() : "";
    if (COMMIT_SHA_RE.test(sha)) return sha;
    if ("error" in head) why = head.error;
  } catch (e) {
    why = String((e as Error)?.message ?? e);
  }
  console.warn(`[site-publish] head unreadable tenant=${tenant_id} site=${site_id}: ${why}`);
  return null;
}

async function releaseSlot(deps: SitePublishDeps, tenant_id: string, conductor_run_id: string): Promise<void> {
  try {
    await deps.discardHeldSlot({ tenant_id, conductor_run_id });
    return;
  } catch (e) {
    console.warn(`[site-publish] publish slot ${conductor_run_id} not discarded tenant=${tenant_id}: ${(e as Error)?.message ?? e}`);
  }
  await deps.republisher.release({ tenant_id, conductor_run_id }).catch((releaseErr: unknown) => {
    console.warn(`[site-publish] publish slot ${conductor_run_id} not released tenant=${tenant_id}: ${(releaseErr as Error)?.message ?? releaseErr}`);
  });
}

export async function handleSitePublish(req: Request, res: Response, deps: SitePublishDeps): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    if (!(await requireTenantRole(auth, PUBLISH_ROLES, res))) return;
  } catch (e) {
    refuse(res, 500, "role_check_failed", (e as Error).message);
    return;
  }
  if (!(await isProductBuilderEnabled())) {
    refuse(res, 403, "product_builder_disabled", "Product builder is not enabled.");
    return;
  }

  const tenant_id = auth.tenant_id;
  const rawId = (req.params as { site_id?: unknown } | undefined)?.site_id;
  const site_id = typeof rawId === "string" ? rawId.trim().toLowerCase() : "";
  if (!SITE_ID_RE.test(site_id)) {
    refuse(res, 400, "bad_request", "site_id must be a uuid");
    return;
  }

  let conductor_run_id: string | null = null;
  try {
    const site = await deps.store.get(tenant_id, site_id);
    if (!site || site.tenant_id !== tenant_id || !isVisibleSite(site)) {
      refuse(res, 404, "site_not_found", "site not found");
      return;
    }
    const repo = (site.github_full_name ?? "").trim();
    if (!repo || NOT_PUBLISHABLE.has(site.status)) {
      refuse(res, 409, "site_unavailable", "This site has nothing to publish yet.");
      return;
    }

    const root = (site.root_conductor_run_id ?? "").trim();
    if (!root) {
      refuse(res, 409, "build_not_finished", BUILD_NOT_FINISHED_MESSAGE);
      return;
    }
    let rootStatus: string | null;
    try {
      rootStatus = await deps.rootRunStatus(tenant_id, root);
    } catch (e) {
      console.warn(`[site-publish] build run unreadable tenant=${tenant_id} site=${site.id}: ${(e as Error)?.message ?? e}`);
      refuse(res, 503, "build_status_unreadable", BUILD_STATUS_UNREADABLE_MESSAGE);
      return;
    }
    if (rootStatus !== "done") {
      refuse(res, 409, "build_not_finished", BUILD_NOT_FINISHED_MESSAGE);
      return;
    }

    const seen = await readHeadSha(deps, repo, tenant_id, site.id);
    if (!seen) {
      refuse(res, 502, "site_head_unreadable", HEAD_UNREADABLE_MESSAGE);
      return;
    }
    if (alreadyLiveAt(site, seen)) {
      refuse(res, 409, "already_published", ALREADY_PUBLISHED_MESSAGE);
      return;
    }

    try {
      conductor_run_id = await deps.republisher.reserve({ tenant_id, site, publish_request: true });
    } catch (e) {
      if (e instanceof DoubleBuildInFlight) {
        refuse(res, 409, "build_already_in_progress", "A build or publish is still running in this workspace. Publish once it finishes.");
        return;
      }
      if (e instanceof TooManyBuildsToday) {
        refuse(res, 429, "daily_build_limit_reached", "You've reached today's limit for changes. You can publish tomorrow.");
        return;
      }
      if (e instanceof ProvisionBudgetExceeded) {
        refuse(res, 402, "provision_budget_exceeded", "This workspace is out of build budget for today.");
        return;
      }
      throw e;
    }

    const reserved = conductor_run_id;
    const sha = await readHeadSha(deps, repo, tenant_id, site.id);
    const current = (await deps.store.get(tenant_id, site.id)) ?? site;
    if (!sha || alreadyLiveAt(current, sha)) {
      conductor_run_id = null;
      await releaseSlot(deps, tenant_id, reserved);
      if (!sha) refuse(res, 502, "site_head_unreadable", HEAD_UNREADABLE_MESSAGE);
      else refuse(res, 409, "already_published", ALREADY_PUBLISHED_MESSAGE);
      return;
    }

    await deps.republisher.start({ tenant_id, conductor_run_id: reserved, site, sha, publish_request: true });
    conductor_run_id = null;
    res.json({ ok: true, conductor_run_id: reserved });
  } catch (e) {
    if (conductor_run_id) await releaseSlot(deps, tenant_id, conductor_run_id);
    console.warn(`[site-publish] publish failed tenant=${tenant_id} site=${site_id}: ${(e as Error)?.message ?? e}`);
    refuse(res, 500, "publish_failed", "We couldn't start publishing. Nothing was published. Please try again.");
  }
}
