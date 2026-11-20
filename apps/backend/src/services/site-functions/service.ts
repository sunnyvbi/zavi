
import { defaultDeployDeps, setSiteFunctionsEnabled, type DeployDeps } from "./deploy";
import { SecretInputError, deleteSiteSecret, putSiteSecret } from "./secrets";
import { SiteFunctionsStoreError } from "./store";
import {
  SiteFunctionsError,
  type FunctionSummary,
  type RunDetail,
  type RunStatus,
  type RunSummary,
  type SiteFunctionsService,
  type SiteRef,
} from "./contract";

export interface SiteFunctionsServiceImpl extends SiteFunctionsService {
  setEnabled(site: SiteRef, enabled: boolean, reason?: string | null): Promise<Record<string, unknown>>;
}

export const SiteFunctionsRequestError = SiteFunctionsError;

type Overview = {
  hostname?: string | null;
  deployment?: { manifest?: { endpoints?: Record<string, { type: "http" | "webhook" }>; schedules?: Record<string, { cron: string }>; secrets?: string[] } } | null;
  schedules?: Array<{ name: string; cron: string; enabled: boolean }>;
};

type RunRow = { id: string; schedule: string; slot: string; state: string; last_status: number | null; created_at: string; finished_at: string | null; last_error: string | null };

function runStatus(state: string, error: string | null): RunStatus {
  if (state === "succeeded") return "ok";
  if (state === "queued" || state === "retry" || state === "running") return "running";
  return error === "timeout" ? "timeout" : "error";
}

function runSummary(r: RunRow): RunSummary {
  const started = r.created_at;
  const ms = r.finished_at ? Math.max(0, Date.parse(r.finished_at) - Date.parse(started)) : null;
  return { id: r.id, started_at: started, duration_ms: ms, status: runStatus(r.state, r.last_error), http_status: r.last_status };
}

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof SecretInputError) throw new SiteFunctionsRequestError(400, "invalid_secret", e.message);
    if (e instanceof SiteFunctionsStoreError && e.notFound) throw new SiteFunctionsRequestError(404, "site_not_found", "This site was not found.");
    if (e instanceof SiteFunctionsStoreError && (e.sqlstate === "54000")) throw new SiteFunctionsRequestError(409, "too_many_secrets", "This site has the maximum number of secrets.");
    if (e instanceof SiteFunctionsStoreError && e.invalid) throw new SiteFunctionsRequestError(400, "invalid_request", "That request is not valid.");
    throw e;
  });
}

export function createSiteFunctionsService(deps: DeployDeps = defaultDeployDeps()): SiteFunctionsServiceImpl {
  const overview = async (site: SiteRef) => (await deps.store.overview(site.tenant_id, site.site_id)) as Overview;
  const allRuns = async (site: SiteRef) => (await deps.store.runsList(site.tenant_id, site.site_id, 200)) as RunRow[];

  async function summaries(site: SiteRef): Promise<FunctionSummary[]> {
    const o = await overview(site);
    const m = o.deployment?.manifest ?? {};
    const origin = o.hostname ? `https://${o.hostname}` : null;
    const runs = await allRuns(site);
    const out: FunctionSummary[] = [];
    for (const [name, e] of Object.entries(m.endpoints ?? {})) {
      out.push({ name, kind: e.type, url: origin ? `${origin}${e.type === "webhook" ? "/api/hooks/" : "/api/fn/"}${name}` : null, cron: null, enabled: null, last_run: null });
    }
    for (const s of o.schedules ?? []) {
      const last = runs.find((r) => r.schedule === s.name);
      out.push({ name: s.name, kind: "schedule", url: null, cron: s.cron, enabled: s.enabled, last_run: last ? runSummary(last) : null });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.kind < b.kind ? -1 : 1));
  }

  return {
    listSecrets: (site) => wrap((async () => {
      const [rows, o] = await Promise.all([deps.store.secretList(site.tenant_id, site.site_id), overview(site)]);
      return {
        secrets: rows.filter((r) => r.scope === "live").map((r) => ({ name: r.name, updated_at: r.updated_at })),
        required: [...(o.deployment?.manifest?.secrets ?? [])].sort(),
      };
    })()),
    putSecret: (site, name, value) => wrap((async () => {
      const r = await putSiteSecret({ store: deps.store, wfp: deps.wfp, log: deps.log }, { tenant_id: site.tenant_id, site_id: site.site_id, name, value });
      return { name: r.name, updated_at: r.updated_at };
    })()),
    deleteSecret: (site, name) => wrap((async () => (await deleteSiteSecret({ store: deps.store, wfp: deps.wfp, log: deps.log }, { tenant_id: site.tenant_id, site_id: site.site_id, name })).deleted)()),
    listFunctions: (site) => wrap(summaries(site)),
    listRuns: (site, fn, opts) => wrap((async () => {
      const fns = await summaries(site);
      const f = fns.filter((x) => x.name === fn);
      if (!f.length) return null;
      if (!f.some((x) => x.kind === "schedule")) return [];
      const limit = Math.min(Math.max(opts.limit, 1), 100);
      const runs = (await allRuns(site)).filter((r) => r.schedule === fn).slice(0, limit);
      return runs.map((r) => ({
        ...runSummary(r),
        log: r.last_error ? [{ at: r.finished_at ?? r.created_at, level: "error" as const, message: r.last_error }] : [],
      }));
    })()),
    setScheduleEnabled: (site, name, enabled) => wrap((async () => {
      if (!(await deps.store.scheduleSetEnabled(site.tenant_id, site.site_id, name, enabled))) return null;
      return (await summaries(site)).find((x) => x.name === name && x.kind === "schedule") ?? null;
    })()),
    setEnabled: async (site, enabled, reason) => (await setSiteFunctionsEnabled(deps, { ...site, enabled, reason })) as Record<string, unknown>,
  };
}
