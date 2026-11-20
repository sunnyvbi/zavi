
import type { KvStore } from "@/services/sites/host-record";
import { bundleFunctions, type RepoReader } from "./bundle";
import { createWfpApi, type WfpApi } from "./cf-api";
import { liveScriptName, requireSiteFunctionsConfig, testScriptName } from "./config";
import { nextFire, parseCron } from "./cron";
import { functionNames, parseFunctionsManifest, type FunctionsSpec } from "./manifest";
import { dropPrincipalRecord, planPrincipals, putPrincipalRecord, type FnKv, type PrincipalPlan } from "./principals";
import { createSiteFunctionsStore, type SiteFunctionsStore, type SyncState } from "./store";
import { randomUUID } from "node:crypto";

export const fnSiteKey = (siteId: string) => `fnsite:${siteId}`;

export interface DeployDeps {
  store: SiteFunctionsStore;
  wfp: () => WfpApi;
  kv: FnKv;
  shardRef: (tenant_id: string, site_id: string) => Promise<string | null>;
  now?: () => Date;
  log?: (line: Record<string, unknown>) => void;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export type StageResult =
  | { kind: "none" }
  | { kind: "superseded" }
  | { kind: "staged"; generation: number; script: string; bundle_sha256: string; missing_secrets: string[] };

export function siteRecord(siteId: string, generation: number, script: string, spec: FunctionsSpec, status: "active" | "disabled", test = false) {
  const endpoints: Record<string, { type: string; principals: string[]; data: string }> = {};
  for (const [n, e] of Object.entries(spec.endpoints)) endpoints[n] = { type: e.type, principals: e.principals, data: e.data };
  const schedules: Record<string, { data: string }> = {};
  for (const [n, s] of Object.entries(spec.schedules)) schedules[n] = { data: s.data };
  return { v: 1, site_id: siteId, status, generation, script, ...(test ? { test: true } : {}), endpoints, schedules, allowed_hosts: spec.allowedHosts };
}

export const storedManifest = (spec: FunctionsSpec, plan: PrincipalPlan) => ({
  endpoints: spec.endpoints, schedules: spec.schedules, secrets: spec.secrets, allowedHosts: spec.allowedHosts, principals: plan,
});

function specFromStored(m: Record<string, unknown> | null): { spec: FunctionsSpec; plan: PrincipalPlan } | null {
  if (!m || typeof m !== "object" || !m.endpoints || !m.schedules) return null;
  const spec: FunctionsSpec = {
    endpoints: m.endpoints as FunctionsSpec["endpoints"],
    schedules: m.schedules as FunctionsSpec["schedules"],
    secrets: Array.isArray(m.secrets) ? (m.secrets as string[]) : [],
    allowedHosts: Array.isArray(m.allowedHosts) ? (m.allowedHosts as string[]) : [],
  };
  const p = (m.principals ?? {}) as Partial<PrincipalPlan>;
  return { spec, plan: { adminFns: Array.isArray(p.adminFns) ? p.adminFns.filter((x): x is string => typeof x === "string") : [] } };
}

function log(deps: DeployDeps, line: Record<string, unknown>): void {
  (deps.log ?? ((l) => console.log(JSON.stringify(l))))({ evt: "site_functions", ...line });
}

async function upload(deps: DeployDeps, tenant_id: string, live_site_id: string, scope: "live" | "test", script: string, spec: FunctionsSpec, reader: RepoReader, tags: string[]) {
  const bundle = await bundleFunctions(reader, functionNames(spec), spec.secrets);
  const values = await deps.store.secretValues(tenant_id, live_site_id, scope);
  const declared = new Set(spec.secrets);
  const secrets = values.filter((v) => declared.has(v.name));
  const present = new Set(secrets.map((s) => s.name));
  return { bundle, secrets, missing: spec.secrets.filter((n) => !present.has(n)), tags };
}

export async function stageSiteFunctions(
  deps: DeployDeps,
  input: { tenant_id: string; site_id: string; generation: number; manifestRaw: unknown; reader: RepoReader },
): Promise<StageResult> {
  const spec = parseFunctionsManifest(input.manifestRaw, (deps.now ?? (() => new Date()))());
  if (!spec) return { kind: "none" };
  if (!Number.isInteger(input.generation) || input.generation < 0) throw new Error("stageSiteFunctions: invalid generation");
  const script = liveScriptName(input.site_id, input.generation);
  const prepared = await upload(deps, input.tenant_id, input.site_id, "live", script, spec, input.reader, [
    `site:${input.site_id}`, `gen:${input.generation}`, "kind:live",
  ]);
  const staged = await deps.store.stage({
    tenant_id: input.tenant_id, live_site_id: input.site_id, site_id: input.site_id, kind: "live",
    generation: input.generation, script, manifest: storedManifest(spec, planPrincipals(spec)), bundle_sha256: prepared.bundle.sha256,
  });
  if (staged === "superseded") {
    log(deps, { step: "stage", outcome: "superseded", site_id: input.site_id, generation: input.generation });
    return { kind: "superseded" };
  }
  await deps.wfp().upload({ script, mainModule: prepared.bundle.mainModule, modules: prepared.bundle.modules, secrets: prepared.secrets, tags: prepared.tags });
  log(deps, { step: "stage", outcome: "staged", site_id: input.site_id, generation: input.generation, script, modules: prepared.bundle.modules.length, missing_secrets: prepared.missing });
  return { kind: "staged", generation: input.generation, script, bundle_sha256: prepared.bundle.sha256, missing_secrets: prepared.missing };
}

export type ActivateResult = { outcome: "activated" | "already" | "superseded" | "deleting"; script: string | null };

export async function activateSiteFunctions(
  deps: DeployDeps,
  input: { tenant_id: string; site_id: string; generation: number; manifestRaw: unknown; staged: StageResult },
): Promise<ActivateResult> {
  const now = (deps.now ?? (() => new Date()))();
  if (input.staged.kind === "superseded") return { outcome: "superseded", script: null };
  const spec = input.staged.kind === "staged" ? parseFunctionsManifest(input.manifestRaw, now) : null;
  if (input.staged.kind === "staged" && (!spec || input.staged.generation !== input.generation)) {
    throw new Error("activateSiteFunctions: staged result does not match this generation / manifest");
  }
  const script = input.staged.kind === "staged" ? input.staged.script : null;
  const schedules = spec
    ? Object.entries(spec.schedules).map(([name, s]) => ({ name, cron: s.cron, data_access: s.data, next_run_at: nextFire(parseCron(s.cron), now).toISOString() }))
    : [];
  const r = await deps.store.activate(input.tenant_id, input.site_id, input.generation, script, schedules);
  if (r.outcome === "superseded" || r.outcome === "deleting") {
    log(deps, { step: "activate", outcome: r.outcome, site_id: input.site_id, generation: input.generation });
    return { outcome: r.outcome, script: null };
  }

  const rec = await reconcileSiteFunctions(deps, input.site_id, 3);
  log(deps, { step: "activate", outcome: r.outcome, site_id: input.site_id, generation: input.generation, script, previous_script: r.previous_script ?? null, reconcile: rec });
  return { outcome: r.outcome, script };
}

export const RECONCILE_LEASE_S = 120;

export async function reconcileSiteFunctions(deps: DeployDeps, site_id: string, attempts = 1): Promise<"synced" | "changed" | "busy"> {
  const holder = deps.newId ? deps.newId() : randomUUID();
  let st: SyncState | null = null;
  for (let i = 0; i < attempts && !st; i++) {
    if (i > 0) await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(500 * i);
    st = await deps.store.reconcileBegin(site_id, holder, RECONCILE_LEASE_S);
  }
  if (!st) return "busy";
  try {
    const live = st.status === "active" || st.status === "disabled";
    const stored = st.active_script && live ? specFromStored(st.manifest) : null;
    if (!stored || st.active_generation === null) {
      await deps.kv.delete(fnSiteKey(site_id));
      await dropPrincipalRecord(deps.kv, site_id);
    } else {
      const script = st.active_script!;
      const values = await deps.store.secretValues(st.tenant_id, site_id, "live");
      const present = new Map(values.filter((v) => stored.spec.secrets.includes(v.name)).map((v) => [v.name, v.value]));
      for (const name of stored.spec.secrets) {
        const v = present.get(name);
        if (v !== undefined) await deps.wfp().putSecret(script, name, v);
        else await deps.wfp().deleteSecret(script, name);
      }
      const ref = await deps.shardRef(st.tenant_id, site_id);
      if (ref && st.status === "active") await putPrincipalRecord(deps.kv, ref, site_id, stored.plan);
      else await dropPrincipalRecord(deps.kv, site_id);
      const status = st.status === "disabled" ? "disabled" : "active";
      await deps.kv.put(fnSiteKey(site_id), JSON.stringify(siteRecord(site_id, st.active_generation, script, stored.spec, status)));
    }
  } catch (e) {
    await deps.store.reconcileEnd(site_id, holder, st.sync_version, false).catch(() => undefined);
    throw e;
  }
  return (await deps.store.reconcileEnd(site_id, holder, st.sync_version, true)) ? "synced" : "changed";
}

export async function reconcileDirtySites(deps: DeployDeps, limit = 50): Promise<{ synced: number; failed: number }> {
  let synced = 0;
  let failed = 0;
  for (const site_id of await deps.store.dirtySites(limit)) {
    try {
      if ((await reconcileSiteFunctions(deps, site_id)) !== "busy") synced++;
    } catch (e) {
      failed++;
      log(deps, { step: "reconcile", outcome: "failed", site_id, error: (e as Error).message.slice(0, 200), alert: "site_function_kv_reconcile_failed" });
    }
  }
  return { synced, failed };
}

export async function setSiteFunctionsEnabled(deps: DeployDeps, input: { tenant_id: string; site_id: string; enabled: boolean; reason?: string | null }) {
  const r = await deps.store.setStatus(input.tenant_id, input.site_id, input.enabled ? "active" : "disabled", input.reason ?? null);
  if (r.outcome !== "ok") return r;
  await reconcileSiteFunctions(deps, input.site_id, 5);
  log(deps, { step: "kill_switch", site_id: input.site_id, enabled: input.enabled });
  return r;
}

export async function deployTestSiteFunctions(
  deps: DeployDeps,
  input: { tenant_id: string; live_site_id: string; test_site_id: string; shard_ref: string | null; manifestRaw: unknown; reader: RepoReader },
): Promise<StageResult> {
  const spec = parseFunctionsManifest(input.manifestRaw, (deps.now ?? (() => new Date()))());
  if (!spec) return { kind: "none" };
  const script = testScriptName(input.test_site_id);
  const prepared = await upload(deps, input.tenant_id, input.live_site_id, "test", script, spec, input.reader, [
    `site:${input.live_site_id}`, `test:${input.test_site_id}`, "kind:test",
  ]);
  await deps.store.stage({
    tenant_id: input.tenant_id, live_site_id: input.live_site_id, site_id: input.test_site_id, kind: "test",
    generation: 0, script, manifest: storedManifest(spec, planPrincipals(spec)), bundle_sha256: prepared.bundle.sha256,
  });
  await deps.wfp().upload({ script, mainModule: prepared.bundle.mainModule, modules: prepared.bundle.modules, secrets: prepared.secrets, tags: prepared.tags });
  if (input.shard_ref) {
    await putPrincipalRecord(deps.kv, input.shard_ref, input.test_site_id, planPrincipals(spec));
  }
  await deps.kv.put(fnSiteKey(input.test_site_id), JSON.stringify(siteRecord(input.test_site_id, 0, script, spec, "active", true)));
  log(deps, { step: "test_deploy", site_id: input.live_site_id, test_site_id: input.test_site_id, script, missing_secrets: prepared.missing });
  return { kind: "staged", generation: 0, script, bundle_sha256: prepared.bundle.sha256, missing_secrets: prepared.missing };
}

export async function destroyTestSiteFunctions(deps: DeployDeps, input: { test_site_id: string }): Promise<void> {
  const script = testScriptName(input.test_site_id);
  await deps.kv.delete(fnSiteKey(input.test_site_id));
  await dropPrincipalRecord(deps.kv, input.test_site_id);
  await deps.wfp().remove(script);
  await deps.store.scriptDeleted(script);
  log(deps, { step: "test_destroy", test_site_id: input.test_site_id, script });
}

export function defaultDeployDeps(): DeployDeps {
  let wfp: WfpApi | null = null;
  return {
    store: createSiteFunctionsStore(),
    wfp: () => (wfp ??= createWfpApi(requireSiteFunctionsConfig())),
    kv: lazyKv(),
    shardRef: async (tenant_id, site_id) => {
      const [{ siteStore }, { existingShardRef }, { shardRegistry }] = await Promise.all([
        import("@/services/sites/store"),
        import("@/services/site-shards/pooled-site"),
        import("@/services/site-shards/registry"),
      ]);
      const site = await siteStore().get(tenant_id, site_id);
      return site ? existingShardRef({ registry: shardRegistry() }, tenant_id, site) : null;
    },
  };
}

export function lazyKv(): FnKv {
  let kv: KvStore | null = null;
  const get = async (): Promise<KvStore> => (kv ??= (await import("@/services/site-shards/gateway-kv")).cloudflareKv());
  return {
    get: async (k) => (await get()).get(k),
    put: async (k, v, o) => (await get()).put(k, v, o),
    delete: async (k) => {
      const c = await get();
      if (!c.delete) throw new Error("site-functions: KV client cannot delete");
      await c.delete(k);
    },
  };
}
