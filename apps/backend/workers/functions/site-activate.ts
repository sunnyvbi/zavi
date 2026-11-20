
import { inngest } from "../client";
import type { StagedDeploy } from "@/services/sites/contract";
import { createSitePublisher, type SitePublisherImpl } from "@/services/hosting/site-publish";
import { siteStore } from "@/services/sites/store";
import { getBoolSetting } from "@/services/settings";
import { requestConductorTick } from "@/services/agents/conductor-kick";
import { SITE_MARKER_SELECT, siteIdFromMarkerRow } from "@/services/sites/site-run";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { recordPrimarySiteAsCompanyWebsite, type PrimarySiteWebsiteInput } from "@/services/sites/primary-site-website";
import { expireSeoAuditForSite } from "@/services/tools/growth/seo/snapshot";

export const SITE_ACTIVATE_EVENT = "site/activate" as const;

export const SITE_POINTER_CONCURRENCY: [{ key: string; limit: number; scope: "env" }] = [
  { key: '"site-pointer:" + event.data.site_id', limit: 1, scope: "env" },
];

const SHA_RE = /^[0-9a-f]{7,40}$/;
const DEPLOY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SiteActivateData = { tenant_id: string; site_id: string; deploy_id: string; sha: string; conductor_run_id?: string; generation?: number };

const validGeneration = (g: unknown): g is number => typeof g === "number" && Number.isSafeInteger(g) && g > 0;

type SendSiteActivate = (event: { id: string; name: typeof SITE_ACTIVATE_EVENT; data: SiteActivateData }) => Promise<unknown>;

const realSend: SendSiteActivate = (event) => inngest.send(event);

export async function requestSiteActivate(
  input: SiteActivateData & { preview_url?: string },
  send: SendSiteActivate = realSend,
): Promise<void> {
  const data: SiteActivateData = {
    tenant_id: input.tenant_id,
    site_id: input.site_id,
    deploy_id: input.deploy_id,
    sha: input.sha,
    ...(input.conductor_run_id && RUN_ID_RE.test(input.conductor_run_id) ? { conductor_run_id: input.conductor_run_id } : {}),
    ...(validGeneration(input.generation) ? { generation: input.generation } : {}),
  };
  await send({ id: `site-activate:${data.site_id}:${data.deploy_id}`, name: SITE_ACTIVATE_EVENT, data });
}

export type SiteActivateDeps = {
  activate: SitePublisherImpl["activate"];
  prune: SitePublisherImpl["prune"];
  reconcile: SitePublisherImpl["reconcile"];
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  kickConductor?: (input: KickInput) => Promise<boolean>;
  recordCompanyWebsite?: (input: PrimarySiteWebsiteInput) => Promise<unknown>;
  expireSeoAudit?: (tenant_id: string, live_url: string) => Promise<unknown>;
};

export type KickInput = { tenant_id: string; site_id: string; conductor_run_id: string };

export type SiteActivateResult = { url: string } | { superseded: true } | { skipped: "bad_request" };

export async function handleSiteActivate(raw: unknown, deps: SiteActivateDeps): Promise<SiteActivateResult> {
  const d = (raw ?? {}) as Record<string, unknown>;
  const tenant_id = typeof d.tenant_id === "string" ? d.tenant_id : "";
  const site_id = typeof d.site_id === "string" ? d.site_id : "";
  const deploy_id = typeof d.deploy_id === "string" ? d.deploy_id : "";
  const sha = typeof d.sha === "string" ? d.sha : "";
  if (!tenant_id || !site_id || !DEPLOY_ID_RE.test(deploy_id) || !SHA_RE.test(sha)) return { skipped: "bad_request" };

  const conductor_run_id = typeof d.conductor_run_id === "string" && RUN_ID_RE.test(d.conductor_run_id) ? d.conductor_run_id : null;
  if (d.generation !== undefined && !validGeneration(d.generation)) return { skipped: "bad_request" };
  const generation = validGeneration(d.generation) ? d.generation : undefined;

  const staged: StagedDeploy = { deploy_id, sha, preview_url: "" };
  let result: { url: string } | { superseded: true };
  try {
    result = await deps.run("activate", () => deps.activate({ tenant_id, site_id, staged, conductor_run_id, ...(generation !== undefined ? { generation } : {}) }));
  } catch (e) {
    await deps
      .run("reconcile", () => deps.reconcile({ tenant_id, site_id, source: "activation" }))
      .catch((re: unknown) => {
        console.warn(`[site-activate] reconcile after a failed activation failed for site ${site_id}: ${String((re as Error)?.message ?? re).slice(0, 300)}`);
      });
    throw e;
  }
  const kick = deps.kickConductor;
  if (conductor_run_id && kick) {
    await deps
      .run("kick-conductor", () => kick({ tenant_id, site_id, conductor_run_id }).catch(() => false))
      .catch(() => undefined);
  }
  if ("url" in result) {
    await deps
      .run("prune", () =>
        deps.prune({ tenant_id, site_id }).catch((e: unknown) => {
          console.warn(`[site-activate] prune failed for site ${site_id}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
          return { deleted: [] as string[] };
        }),
      )
      .catch(() => undefined);
    const record = deps.recordCompanyWebsite;
    if (record) {
      const url = result.url;
      await deps
        .run("company-website", () =>
          record({ tenant_id, site_id, url }).catch((e: unknown) => {
            console.warn(`[site-activate] company website not recorded for site ${site_id}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
            return "failed";
          }),
        )
        .catch(() => undefined);
    }
    const expireSeo = deps.expireSeoAudit;
    if (expireSeo) {
      const url = result.url;
      await deps.run("seo-snapshot-expire", () => expireSeo(tenant_id, url).catch(() => undefined)).catch(() => undefined);
    }
  }
  return result;
}

export async function runBelongsToSite(input: KickInput): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(input.tenant_id))
    .from("conductor_runs")
    .select(`id, ${SITE_MARKER_SELECT}`)
    .eq("id", input.conductor_run_id)
    .maybeSingle();
  if (error || !data) return false;
  const row = data as { id?: unknown; s0?: unknown; s1?: unknown; s2?: unknown };
  if (row.id !== input.conductor_run_id) return false;
  return siteIdFromMarkerRow(row) === input.site_id.trim().toLowerCase();
}

export async function kickConductorAfterActivate(
  input: KickInput,
  belongs: (input: KickInput) => Promise<boolean> = runBelongsToSite,
): Promise<boolean> {
  let on = false;
  try {
    on = (await getBoolSetting("site_activate_kicks_conductor", input.tenant_id)) === true;
  } catch {
    on = false;
  }
  if (!on) return false;
  let owned = false;
  try {
    owned = await belongs(input);
  } catch (e) {
    console.warn(`[site-activate] run ownership check failed for run ${input.conductor_run_id}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    return false;
  }
  if (!owned) {
    console.warn(
      `[site-activate] refused to kick run ${input.conductor_run_id}: it is not a run of site ${input.site_id} in tenant ${input.tenant_id}`,
    );
    return false;
  }
  return requestConductorTick(inngest, input.conductor_run_id);
}

let _publisher: SitePublisherImpl | null = null;
function publisher(): SitePublisherImpl {
  return (_publisher ??= createSitePublisher({ store: siteStore() }));
}

export const siteActivateFn = inngest.createFunction(
  {
    id: "site-activate",
    retries: 3,
    concurrency: SITE_POINTER_CONCURRENCY,
  },
  { event: SITE_ACTIVATE_EVENT },
  async ({ event, step }) =>
    handleSiteActivate(event.data, {
      activate: (input) => publisher().activate(input),
      prune: (input) => publisher().prune(input),
      reconcile: (input) => publisher().reconcile(input),
      run: (name, fn) => step.run(name, fn) as never,
      kickConductor: kickConductorAfterActivate,
      recordCompanyWebsite: (input) => recordPrimarySiteAsCompanyWebsite(input),
      expireSeoAudit: expireSeoAuditForSite,
    }),
);
