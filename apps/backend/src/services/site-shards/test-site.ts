
import { randomBytes } from "node:crypto";
import type { SiteRow } from "@/services/sites/contract";
import { SITE_POINTER_TERMINAL } from "@/services/sites/contract";
import type { KvStore } from "@/services/sites/host-record";
import {
  EMPTY_SITE_CONTRACT,
  PROVISION_DONE,
  REQUIRED_SHARD_SCHEMA,
  V2_SHARD_SCHEMA,
  type CollectionDef,
  type PooledSiteAuth,
  type ShardEnv,
  type ShardHandle,
  type ShardSql,
  type ShardStorage,
  type SiteContractDef,
  type SiteManifestPackage,
} from "./contract";
import { applySitePlanSql, readCollectionsV2, readSiteContract, refusalFromError } from "./apply-v2";
import { CollectionPlanRefused, planSite, sitePlanIsEmpty } from "./collections-plan";
import { collectionsVia, siteContractVia, uncarriedParts, validateWith, validationErrors } from "./manifest-adapter";
import { readLedger } from "./migrations";
import { purgeShardSiteData } from "./pooled-site";
import { isPreviewHost, PREVIEW_LABEL_RE, previewKvKey } from "./preview-routing";
import type { ShardRegistry } from "./registry";
import { ensureShardSite, isActiveAdmin, markShardSiteDeleting } from "./shard-ops";
import { isUuid } from "./sql";

export const TEST_SITE_TTL_DEFAULT_S = 900;
export const TEST_SITE_TTL_MIN_S = 300;
export const TEST_SITE_TTL_MAX_S = 3600;
const DEPLOY_ID_RE = /^d[0-9a-z]{9}-[0-9a-f]{8}$/;
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const REF_RE = /^[a-z0-9]{20}$/;
export const TEST_SITE_CREATE_DEADLINE_MS = 10 * 60_000;
export const EDGE_READY_TIMEOUT_MS = 90_000;
export const ORPHAN_SCAN_LIMIT = 500;

export const ORPHAN_AUTH_USERS_SQL = `select u.id::text as id from auth.users u
  where u.created_at < now() - interval '1 hour'
    and not exists (select 1 from zsite.identities i where i.auth_user_id = u.id)
  order by u.created_at limit ${ORPHAN_SCAN_LIMIT}`;

export class TestSiteRefused extends Error {
  constructor(public reason: string, public errors: string[] = [], public code?: string) {
    super(`test site refused: ${reason}`);
    this.name = "TestSiteRefused";
  }
}

export class TestSiteUnavailable extends Error {
  constructor(
    public reason: string,
    public readonly capacity = false,
  ) {
    super(`test site unavailable: ${reason}`);
    this.name = "TestSiteUnavailable";
  }
}

export type TestSiteHandle = {
  test_site_id: string;
  preview_host: string;
  owner_login: string | null;
  owner_email: string | null;
  customer_login: string | null;
  expires_at: string;
};

export type TestSiteRow = {
  id: string;
  tenant_id: string;
  live_site_id: string;
  env: ShardEnv;
  shard_id: string;
  project_ref: string | null;
  url: string | null;
  preview_host: string;
  deploy_id: string;
  state: "creating" | "active" | "destroying" | "destroyed";
  expires_at: string;
  attempts: number;
};

export type PreviewRecord = {
  v: 1;
  hostname: string;
  test_site_id: string;
  deploy_id: string;
  exp: number;
  shard_id: string;
  shard_url: string;
};

type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };

export type TestSiteDeps = {
  tenantRpc: (tenant_id: string, name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
  platformRpc: (name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
  registry: Pick<ShardRegistry, "get" | "list">;
  sql: ShardSql;
  storage: ShardStorage;
  auth: PooledSiteAuth | null;
  manifest: SiteManifestPackage | null;
  kv: KvStore;
  getSite: (tenant_id: string, site_id: string) => Promise<SiteRow | null>;
  env: () => ShardEnv;
  previewDomain: () => string | null;
  ensureRouting: () => Promise<void>;
  edgeReady?: (preview_host: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  randomLabel?: () => string;
  now?: () => number;
  log?: (line: string) => void;
  alert?: (code: string, msg: string) => Promise<void>;
};

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export function randomPreviewLabel(): string {
  const bytes = randomBytes(17);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

const clip = (e: unknown, n = 300) => String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, n);

function logLine(deps: TestSiteDeps, event: string, fields: Record<string, unknown>): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v.replace(/\s+/g, "_") : JSON.stringify(v)}`);
  (deps.log ?? ((l: string) => console.warn(l)))(`[test-site] event=${event} ${parts.join(" ")}`);
}

async function call(deps: TestSiteDeps, tenant_id: string | null, name: string, args: Record<string, unknown>): Promise<unknown> {
  const r = tenant_id ? await deps.tenantRpc(tenant_id, name, args) : await deps.platformRpc(name, args);
  if (r.error) {
    const err = new Error(`${name} failed${r.error.code ? ` (${r.error.code})` : ""}: ${r.error.message ?? "unknown"}`) as Error & { code?: string };
    err.code = r.error.code;
    throw err;
  }
  return r.data;
}

function rowOf(data: unknown): TestSiteRow | null {
  const r = (Array.isArray(data) ? data[0] : data) as TestSiteRow | null | undefined;
  return r && isUuid(r.id) ? r : null;
}

function shardOf(row: Pick<TestSiteRow, "shard_id" | "project_ref" | "url">): ShardHandle {
  if (!row.project_ref || !REF_RE.test(row.project_ref) || row.url !== `https://${row.project_ref}.supabase.co`) {
    throw new TestSiteUnavailable("the validation shard has no project");
  }
  return { id: row.shard_id, project_ref: row.project_ref, url: row.url };
}

async function assertValidationShard(deps: TestSiteDeps, shard: ShardHandle): Promise<void> {
  const row = await deps.registry.get(shard.id);
  if (!row || row.project_ref !== shard.project_ref) throw new TestSiteUnavailable("validation shard not in the registry");
  if (row.purpose !== "validation") throw new TestSiteUnavailable(`shard ${row.name} is not a validation shard`);
  if (row.state !== "full" || row.provision_step !== PROVISION_DONE) throw new TestSiteUnavailable(`validation shard ${row.name} is not serving`);
  const ledger = await readLedger(deps.sql, shard.project_ref);
  if (!ledger.has(REQUIRED_SHARD_SCHEMA) || !ledger.has(V2_SHARD_SCHEMA)) {
    throw new TestSiteUnavailable(`validation shard ${row.name} lacks the current schema`);
  }
}

function candidateContract(deps: TestSiteDeps, manifestRaw: unknown): { desired: CollectionDef[]; contract: SiteContractDef; hash: string } {
  if (manifestRaw == null) return { desired: [], contract: EMPTY_SITE_CONTRACT, hash: "none" };
  const v = validateWith(deps.manifest, manifestRaw);
  if (!v.ok) throw new TestSiteRefused("zavi-site.json is invalid", validationErrors(v).slice(0, 20));
  const lost = uncarriedParts(v.value);
  if (lost.length) {
    throw new TestSiteRefused("zavi-site.json uses parts this database cannot apply yet", [`unsupported: ${lost.slice(0, 5).join(", ")}`]);
  }
  return { desired: collectionsVia(deps.manifest, v.value), contract: siteContractVia(deps.manifest, v.value), hash: v.hash };
}

function mapCreateError(e: unknown): Error {
  const code = (e as { code?: string })?.code;
  if (code === "53400") return new TestSiteUnavailable("no validation shard has room", true);
  if (code === "54000") return new TestSiteUnavailable("this site already has the maximum number of live test sites");
  if (code === "P0002" || code === "55000") return new TestSiteRefused(clip(e));
  return new TestSiteUnavailable(clip(e));
}

export async function createTestSiteWith(
  deps: TestSiteDeps,
  input: { tenant_id: string; live_site_id: string; manifestRaw: unknown; deploy_id: string; ttl?: number },
): Promise<TestSiteHandle> {
  const now = deps.now ?? Date.now;
  const started = now();
  const { tenant_id, live_site_id, deploy_id } = input;
  if (!isUuid(tenant_id) || !isUuid(live_site_id)) throw new TestSiteRefused("tenant and site ids must be uuids");
  if (typeof deploy_id !== "string" || !DEPLOY_ID_RE.test(deploy_id)) throw new TestSiteRefused("invalid deploy id");
  const ttl = Math.min(Math.max(Math.floor(Number(input.ttl ?? TEST_SITE_TTL_DEFAULT_S)) || TEST_SITE_TTL_DEFAULT_S, TEST_SITE_TTL_MIN_S), TEST_SITE_TTL_MAX_S);
  if (!deps.auth) throw new TestSiteUnavailable("site auth broker is not wired");
  if (!deps.manifest) throw new TestSiteUnavailable("manifest package is not wired");
  const domain = deps.previewDomain();
  if (!domain) throw new TestSiteUnavailable("SITE_PREVIEW_DOMAIN is not configured");

  const { desired, contract, hash } = candidateContract(deps, input.manifestRaw);

  const live = await deps.getSite(tenant_id, live_site_id);
  if (!live || live.id !== live_site_id || live.tenant_id !== tenant_id) throw new TestSiteRefused("site not found");
  if (SITE_POINTER_TERMINAL.has(live.status)) throw new TestSiteRefused(`site is ${live.status}`);
  const liveHost = String(live.hostname ?? "").toLowerCase();
  if (!HOST_RE.test(liveHost) || isPreviewHost(liveHost, domain)) throw new TestSiteRefused("the site has no valid hostname");

  const region = live.shard_id ? ((await deps.registry.get(live.shard_id).catch(() => null))?.region ?? null) : null;

  try {
    await deps.ensureRouting();
  } catch (e) {
    throw new TestSiteUnavailable(`preview routing: ${clip(e, 200)}`);
  }

  const label = (deps.randomLabel ?? randomPreviewLabel)();
  if (!PREVIEW_LABEL_RE.test(label)) throw new Error("preview label generator returned a malformed label");
  const preview_host = `${label}.${domain}`;
  const owner_email = `gate-owner@${preview_host}`;
  const customer_email = `gate-customer@${preview_host}`;

  let created: { id: string; shard_id: string; project_ref: string | null; url: string | null; expires_at: string };
  try {
    const data = await call(deps, tenant_id, "site_test_site_create", {
      p_live_site_id: live_site_id, p_env: deps.env(), p_region: region, p_preview_host: preview_host, p_deploy_id: deploy_id, p_ttl_seconds: ttl,
    });
    const r = (Array.isArray(data) ? data[0] : data) as typeof created | undefined;
    if (!r || !isUuid(r.id) || !isUuid(r.shard_id)) throw new Error("site_test_site_create returned no row");
    created = r;
  } catch (e) {
    const err = e instanceof TestSiteRefused || e instanceof TestSiteUnavailable ? e : mapCreateError(e);
    if (err instanceof TestSiteUnavailable && /room/.test(err.reason)) {
      await deps.alert?.("sites.test_sites.no_capacity", `no validation shard has room for a publish-gate test site (${deps.env()}); gates wait until the hourly check adds one`).catch(() => undefined);
    }
    logLine(deps, "create_refused", { tenant: tenant_id, live_site: live_site_id, reason: clip(err, 160) });
    throw err;
  }

  const test_site_id = created.id;
  const step = (what: string) => {
    if (now() - started > TEST_SITE_CREATE_DEADLINE_MS) throw new TestSiteUnavailable(`test site create timed out before ${what}`);
  };
  try {
    step("shard");
    const shard = shardOf({ shard_id: created.shard_id, project_ref: created.project_ref, url: created.url });
    await assertValidationShard(deps, shard);
    const ref = shard.project_ref;

    step("contract");
    await ensureShardSite(deps.sql, ref, test_site_id);
    const current = await readCollectionsV2(deps.sql, ref, test_site_id);
    const currentContract = await readSiteContract(deps.sql, ref, test_site_id);
    let plan;
    try {
      plan = planSite(current, desired, currentContract ?? EMPTY_SITE_CONTRACT, contract);
    } catch (e) {
      if (e instanceof CollectionPlanRefused) throw new TestSiteRefused(e.message);
      throw e;
    }
    if (!sitePlanIsEmpty(plan) || !currentContract) {
      try {
        await deps.sql.query(ref, applySitePlanSql(test_site_id, plan, current, currentContract, [], hash));
      } catch (e) {
        const refused = refusalFromError(e);
        if (refused) throw new TestSiteRefused(refused.message, [], refused.code);
        throw e;
      }
    }

    const hasOwner = !!live.owner_email;
    step("owner");
    if (hasOwner) {
      const { user_id } = await deps.auth.ensureFounderAdmin({ shard, site_id: test_site_id, email: owner_email });
      if (!(await isActiveAdmin(deps.sql, ref, test_site_id, user_id))) throw new TestSiteUnavailable("test owner admin membership did not verify");
    }
    const hasCustomer = hasOwner && !!deps.auth.ensureCustomer && !!deps.auth.customerMagicLink;
    step("customer");
    if (hasCustomer) {
      await deps.auth.ensureCustomer!({ shard, site_id: test_site_id, email: customer_email, admin_email: owner_email });
    }

    const exp = Math.floor(Date.parse(created.expires_at) / 1000);
    if (!Number.isFinite(exp)) throw new Error("site_test_site_create returned no expiry");
    const record: PreviewRecord = { v: 1, hostname: liveHost, test_site_id, deploy_id, exp, shard_id: ref, shard_url: shard.url };
    const value = JSON.stringify(record);
    await deps.kv.put(previewKvKey(preview_host), value, { expirationTtl: Math.max(60, exp - Math.floor(now() / 1000) + 60) });
    if ((await deps.kv.get(previewKvKey(preview_host))) !== value) throw new TestSiteUnavailable("the preview binding did not read back");
    if (deps.edgeReady) {
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const until = now() + EDGE_READY_TIMEOUT_MS;
      while (!(await deps.edgeReady(preview_host).catch(() => false))) {
        if (now() >= until) throw new TestSiteUnavailable("the preview host is not visible at the edge yet");
        await sleep(2_000);
      }
    }
    step("activate");

    await call(deps, tenant_id, "site_test_site_activate", { p_id: test_site_id, p_manifest_hash: hash });
    const owner_login = hasOwner
      ? await deps.auth.ownerMagicLink({ shard, site_id: test_site_id, email: owner_email, redirect_to: `https://${preview_host}/` })
      : null;
    const customer_login = hasCustomer
      ? await deps.auth.customerMagicLink!({ shard, site_id: test_site_id, email: customer_email, redirect_to: `https://${preview_host}/` })
      : null;
    logLine(deps, "created", {
      tenant: tenant_id, live_site: live_site_id, test_site: test_site_id, shard: ref, collections: desired.length, ttl_s: ttl,
      customer: customer_login !== null, ms: now() - started,
    });
    return { test_site_id, preview_host, owner_login, owner_email: hasOwner ? owner_email : null, customer_login, expires_at: created.expires_at };
  } catch (e) {
    logLine(deps, "create_failed", { tenant: tenant_id, live_site: live_site_id, test_site: test_site_id, error: clip(e, 200) });
    await destroyTestSiteWith(deps, { tenant_id, test_site_id, reason: "create_failed" }).catch((d: unknown) => {
      logLine(deps, "destroy_after_failed_create_failed", { test_site: test_site_id, error: clip(d, 200) });
    });
    if (e instanceof TestSiteRefused || e instanceof TestSiteUnavailable) throw e;
    throw new TestSiteUnavailable(clip(e));
  }
}

async function removePreviewRecord(deps: TestSiteDeps, row: Pick<TestSiteRow, "id" | "preview_host">): Promise<void> {
  const key = previewKvKey(row.preview_host);
  const raw = await deps.kv.get(key);
  if (raw === null) return;
  try {
    const v = JSON.parse(raw) as { test_site_id?: unknown };
    if (typeof v?.test_site_id === "string" && v.test_site_id !== row.id) return;
  } catch {
  }
  if (!deps.kv.delete) throw new TestSiteUnavailable("this KV store cannot remove a record");
  await deps.kv.delete(key);
}

export async function destroyTestSiteWith(
  deps: TestSiteDeps,
  input: { tenant_id: string; test_site_id: string; reason?: string },
): Promise<"destroyed" | "already" | "absent"> {
  const { tenant_id, test_site_id } = input;
  if (!isUuid(tenant_id) || !isUuid(test_site_id)) return "absent";
  const started = (deps.now ?? Date.now)();
  const row = rowOf(await call(deps, tenant_id, "site_test_site_destroy_begin", { p_id: test_site_id, p_reason: input.reason ?? "requested" }));
  if (!row) return "absent";
  if (row.state === "destroyed") return "already";
  try {
    await removePreviewRecord(deps, row);
    const shard = shardOf(row);
    await markShardSiteDeleting(deps.sql, shard.project_ref, test_site_id);
    await purgeShardSiteData({ sql: deps.sql, storage: deps.storage, auth: deps.auth }, shard, test_site_id, `validation shard ${shard.project_ref}`);
    await call(deps, tenant_id, "site_test_site_destroyed", { p_id: test_site_id });
    logLine(deps, "destroyed", { tenant: tenant_id, test_site: test_site_id, reason: input.reason ?? "requested", ms: (deps.now ?? Date.now)() - started });
    return "destroyed";
  } catch (e) {
    const attempts = await Promise.resolve(call(deps, tenant_id, "site_test_site_failed", { p_id: test_site_id, p_error: clip(e, 480) })).catch(() => null);
    logLine(deps, "destroy_failed", { tenant: tenant_id, test_site: test_site_id, attempts, error: clip(e, 200) });
    throw e;
  }
}

export async function testSiteOwnerLinkWith(deps: TestSiteDeps, input: { tenant_id: string; test_site_id: string }): Promise<string> {
  if (!deps.auth) throw new TestSiteUnavailable("site auth broker is not wired");
  if (!isUuid(input.tenant_id) || !isUuid(input.test_site_id)) throw new TestSiteRefused("ids must be uuids");
  const row = rowOf(await call(deps, input.tenant_id, "site_test_site_get", { p_id: input.test_site_id }));
  const now = (deps.now ?? Date.now)();
  if (!row || row.state !== "active" || Date.parse(row.expires_at) <= now) throw new TestSiteRefused("the test site is not active");
  return deps.auth.ownerMagicLink({
    shard: shardOf(row), site_id: row.id, email: `gate-owner@${row.preview_host}`, redirect_to: `https://${row.preview_host}/`,
  });
}

export type TestSiteSweep = {
  due: number;
  destroyed: number;
  failed: number;
  orphans: number;
  orphans_purged: number;
  orphan_users: number;
  orphan_users_deleted: number;
  stats: Record<string, number> | null;
  leak: number;
};

export async function sweepTestSitesWith(deps: TestSiteDeps, opts: { limit?: number } = {}): Promise<TestSiteSweep> {
  const env = deps.env();
  const out: TestSiteSweep = { due: 0, destroyed: 0, failed: 0, orphans: 0, orphans_purged: 0, orphan_users: 0, orphan_users_deleted: 0, stats: null, leak: 0 };
  try {
    const due = ((await call(deps, null, "site_test_site_due", { p_env: env, p_limit: opts.limit ?? 50 })) ?? []) as Array<{ id: string; tenant_id: string; state: string }>;
    out.due = due.length;
    for (const r of due) {
      try {
        const res = await destroyTestSiteWith(deps, { tenant_id: r.tenant_id, test_site_id: r.id, reason: r.state === "destroying" ? "retry" : "expired" });
        if (res === "destroyed") out.destroyed++;
      } catch {
        out.failed++;
      }
    }
  } catch (e) {
    out.failed++;
    logLine(deps, "sweep_due_failed", { env, error: clip(e, 200) });
  }

  try {
    const shards = (await deps.registry.list(env)).filter((s) => s.purpose === "validation" && s.project_ref && s.url && s.state !== "retired" && s.state !== "provisioning");
    for (const s of shards) {
      const ref = s.project_ref as string;
      const handle = { id: s.id, project_ref: ref, url: s.url as string };
      try {
        const users = ((await deps.sql.query(ref, ORPHAN_AUTH_USERS_SQL)) as Array<{ id?: string }>).map((r) => String(r.id ?? "")).filter(isUuid);
        out.orphan_users += users.length;
        for (const auth_user_id of users) {
          if (!deps.auth) break;
          try {
            await deps.auth.deleteAuthUser({ shard: handle, auth_user_id });
            out.orphan_users_deleted++;
          } catch (e) {
            logLine(deps, "orphan_user_delete_failed", { shard: ref, error: clip(e, 160) });
          }
        }
      } catch (e) {
        logLine(deps, "orphan_user_scan_failed", { shard: ref, error: clip(e, 160) });
      }
      const ids = ((await deps.sql.query(ref, `select site_id::text as site_id from zsite.sites order by site_id limit ${ORPHAN_SCAN_LIMIT}`)) as Array<{ site_id?: string }>)
        .map((r) => String(r.site_id ?? ""))
        .filter(isUuid);
      if (!ids.length) continue;
      const known = ((await call(deps, null, "site_test_site_states", { p_ids: ids })) ?? []) as Array<{ id: string; state: string }>;
      const live = new Set(known.filter((k) => k.state !== "destroyed").map((k) => k.id));
      for (const id of ids.filter((x) => !live.has(x))) {
        out.orphans++;
        try {
          await markShardSiteDeleting(deps.sql, ref, id);
          await purgeShardSiteData({ sql: deps.sql, storage: deps.storage, auth: deps.auth }, handle, id, `validation shard ${s.name}`);
          out.orphans_purged++;
          logLine(deps, "orphan_purged", { shard: ref, test_site: id });
        } catch (e) {
          logLine(deps, "orphan_purge_failed", { shard: ref, test_site: id, error: clip(e, 200) });
        }
      }
    }
  } catch (e) {
    logLine(deps, "sweep_orphans_failed", { env, error: clip(e, 200) });
  }

  try {
    out.stats = ((await call(deps, null, "site_test_site_stats", { p_env: env })) ?? null) as Record<string, number> | null;
  } catch (e) {
    logLine(deps, "stats_failed", { env, error: clip(e, 200) });
  }
  const overdue = Number(out.stats?.overdue ?? 0) || 0;
  const stuck = Number(out.stats?.stuck ?? 0) || 0;
  const leaked = Number(out.stats?.leaked ?? Math.max(overdue, stuck)) || 0;
  out.leak = leaked + (out.orphans - out.orphans_purged) + (out.orphan_users - out.orphan_users_deleted);
  logLine(deps, "metrics", {
    env, due: out.due, destroyed: out.destroyed, failed: out.failed, orphans: out.orphans, orphans_purged: out.orphans_purged,
    orphan_users: out.orphan_users, orphan_users_deleted: out.orphan_users_deleted,
    active: out.stats?.active ?? null, creating: out.stats?.creating ?? null, destroying: out.stats?.destroying ?? null, overdue, stuck, leak: out.leak,
  });
  if (out.leak > 0 || out.orphans > 0 || out.orphan_users > 0) {
    await deps.alert?.(
      "sites.test_sites.leak",
      `publish-gate test sites are leaking (${env}): ${overdue} past their TTL by 15+ min, ${stuck} with 3+ failed destroys, ${out.orphans} orphan site(s) found on validation shards (${out.orphans_purged} purged), ${out.orphan_users} leaked auth user(s) (${out.orphan_users_deleted} deleted). The hourly sweep retries; see [test-site] logs.`,
    ).catch(() => undefined);
  }
  return out;
}

export async function productionTestSiteDeps(): Promise<TestSiteDeps> {
  const [{ pooledSiteDeps }, tc, routing] = await Promise.all([import("./facade"), import("@/services/tenant-client"), import("./preview-routing")]);
  const d = pooledSiteDeps();
  return {
    tenantRpc: (tenant_id, name, args) => tc.tenantRpc(tc.asTenantId(tenant_id), name, args) as unknown as PromiseLike<RpcResult>,
    platformRpc: (name, args) => tc.siteShardRpc(name, args) as unknown as PromiseLike<RpcResult>,
    registry: d.registry,
    sql: d.sql,
    storage: d.storage,
    auth: d.auth,
    manifest: d.manifest,
    kv: d.kv,
    getSite: d.getSite,
    env: d.env,
    edgeReady: previewEdgeReady,
    previewDomain: () => routing.previewDomain(),
    ensureRouting: () => routing.ensurePreviewRouting(),
    alert: async (code, msg) => {
      const { alert } = await import("@/services/logging/alert");
      await alert({ msg, source: "site-test-sites", code });
    },
    log: (l) => console.warn(l),
  };
}

export async function previewEdgeReady(preview_host: string): Promise<boolean> {
  const probe = async (path: string) => {
    const res = await fetch(`https://${preview_host}${path}`, { method: "GET", headers: { accept: "text/html" }, redirect: "manual", signal: AbortSignal.timeout(5_000) });
    await res.body?.cancel().catch(() => undefined);
    return res.status === 403;
  };
  const [page, api] = await Promise.all([probe("/"), probe("/api/site")]);
  return page && api;
}

export async function createTestSite(input: { tenant_id: string; live_site_id: string; manifestRaw: unknown; deploy_id: string; ttl?: number }): Promise<TestSiteHandle> {
  return createTestSiteWith(await productionTestSiteDeps(), input);
}

export async function destroyTestSite(input: { tenant_id: string; test_site_id: string; reason?: string }): Promise<"destroyed" | "already" | "absent"> {
  return destroyTestSiteWith(await productionTestSiteDeps(), input);
}

export async function testSiteOwnerLink(input: { tenant_id: string; test_site_id: string }): Promise<string> {
  return testSiteOwnerLinkWith(await productionTestSiteDeps(), input);
}

export async function runTestSiteSweep(): Promise<TestSiteSweep | { skipped: string }> {
  const { autoProvisionAllowed } = await import("./autoprovision");
  const g = autoProvisionAllowed();
  if (!g.ok) return { skipped: g.reason ?? "not_allowed" };
  try {
    return await sweepTestSitesWith(await productionTestSiteDeps());
  } catch (e) {
    console.warn(`[test-site] event=sweep_failed error=${clip(e, 200).replace(/\s+/g, "_")}`);
    return { skipped: "sweep_failed" };
  }
}
