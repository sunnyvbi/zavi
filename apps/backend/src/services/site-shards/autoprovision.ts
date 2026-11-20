
import type { ShardEnv, ShardPurpose, ShardRow } from "./contract";
import { LOAD_DIMS, PAUSE_ALERT_AFTER_S, ROLLOUT_IN_PROGRESS, SOFT_DIMS, ignoredDims, isSoftFull, staleSources } from "./metrics";
import type { ShardCapacityInputs } from "./registry";

export const SHARD_PROVISION_EVENT = "site-shards/provision.requested";
export const RETRY_BASE_SECONDS = 30 * 60;
export const AUTO_SOURCE = "site-shards-autoprovision";
const GLOBAL_SETTING_TENANT = "00000000-0000-0000-0000-000000000000";

export type ShardLoadRow = Pick<ShardRow, "id" | "name" | "state" | "project_ref" | "site_count" | "max_sites"> &
  Partial<Pick<ShardRow, "dedicated_site_id" | "url" | "purpose" | "region">> &
  Partial<Record<"m_db_at" | "m_gateway_at" | "m_cpu_at" | "placement_paused_until" | "placement_paused_reason" | "placement_paused_at" | "created_at" | "soft_full_at", string | null>> &
  Partial<Record<"m_unconfigured", string[] | null>> &
  Partial<Record<
    | "m_records" | "m_bytes" | "m_requests_per_min" | "m_p95_ms" | "m_cpu_pct" | "m_connections" | "m_auth_users" | "m_sessions" | "m_emails_per_hour"
    | "lim_records" | "lim_bytes" | "lim_requests_per_min" | "lim_p95_ms" | "lim_cpu_pct" | "lim_connections" | "lim_auth_users" | "lim_sessions" | "lim_emails_per_hour"
    | "fill_ratio" | "metrics_max_age_s" | "soft_min_rpm" | "soft_close_readings" | "m_soft_over",
    number | string | null
  >>;

const DIMS = LOAD_DIMS;

const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);

function loadOver(s: ShardLoadRow, keep: (dim: string) => boolean, withSites: boolean): number {
  let load = withSites ? (s.max_sites > 0 ? num(s.site_count) / s.max_sites : 1) : 0;
  const skip = ignoredDims(s);
  for (const [m, lim] of DIMS) {
    if (skip.has(m) || !keep(m)) continue;
    const l = num(s[lim]);
    if (l > 0) load = Math.max(load, num(s[m]) / l);
  }
  return load;
}

export function shardLoad(s: ShardLoadRow): number {
  return loadOver(s, () => true, true);
}

export function shardHardLoad(s: ShardLoadRow): number {
  return loadOver(s, (m) => !SOFT_DIMS.has(m), true);
}

export const isNumberedShard = (s: Pick<ShardRow, "name"> & Partial<Pick<ShardRow, "dedicated_site_id">>) =>
  !s.dedicated_site_id && /^zavi-shard-(prod|dev)-[0-9]{1,6}$/.test(s.name);

export const isPooledShard = (s: Pick<ShardRow, "name"> & Partial<Pick<ShardRow, "dedicated_site_id" | "purpose">>) =>
  isNumberedShard(s) && (s.purpose ?? "pool") === "pool";

export const isValidationShard = (s: Pick<ShardRow, "name"> & Partial<Pick<ShardRow, "dedicated_site_id" | "purpose">>) =>
  isNumberedShard(s) && s.purpose === "validation";

export function envHeadroom(rows: ShardLoadRow[], opts: { nowMs?: number } = {}): { open: number; headroom: number; stale: number } {
  let room = 0;
  let capacity = 0;
  let open = 0;
  let stale = 0;
  for (const s of rows) {
    if (!isPooledShard(s) || !s.project_ref) continue;
    if (s.state !== "open" && s.state !== "full") continue;
    if (opts.nowMs !== undefined && staleSources(s, opts.nowMs).length) {
      stale++;
      continue;
    }
    const fill = Math.min(Math.max(num(s.fill_ratio, 0.8), 0.01), 1);
    capacity += fill;
    if (s.state === "open") {
      const left = Math.max(0, fill - shardHardLoad(s));
      if (left > 0 && s.site_count < s.max_sites) open++;
      room += isSoftFull(s) ? 0 : left;
    }
  }
  return { open, headroom: capacity > 0 ? room / capacity : 0, stale };
}

export const DEFAULT_LEAD_TIME_S = 3600;
export const DEFAULT_SITES_PER_SHARD = 1600;
export const WARM_SAFETY = 2;

export type WarmTarget = {
  demand_sites: number;
  need: number;
  have: number;
  spare_sites: number;
  short: boolean;
};

export function rolloutPauseInProgress(s: Pick<ShardLoadRow, "placement_paused_reason" | "placement_paused_at">, nowMs: number): boolean {
  if (!String(s.placement_paused_reason ?? "").startsWith(ROLLOUT_IN_PROGRESS)) return false;
  const at = s.placement_paused_at ? new Date(s.placement_paused_at).getTime() : NaN;
  return Number.isFinite(at) && nowMs - at < PAUSE_ALERT_AFTER_S * 1000;
}

export function warmTarget(rows: ShardLoadRow[], inputs: ShardCapacityInputs, nowMs: number): WarmTarget {
  const perHour = Math.max(num(inputs.placements_1h), num(inputs.placements_24h) / 24);
  const leadH = Math.min(Math.max(num(inputs.lead_time_s ?? DEFAULT_LEAD_TIME_S, DEFAULT_LEAD_TIME_S) / 3600, 0.25), 24);
  const demand = Math.ceil(perHour * leadH * WARM_SAFETY);
  let have = 0;
  let spare = 0;
  for (const s of rows) {
    if (!isPooledShard(s) || !s.project_ref || s.state !== "open") continue;
    if (staleSources(s, nowMs).length) continue;
    if (isSoftFull(s)) continue;
    const pausedUntil = s.placement_paused_until ? new Date(s.placement_paused_until).getTime() : NaN;
    if (s.placement_paused_until && (Number.isNaN(pausedUntil) || pausedUntil > nowMs) && !rolloutPauseInProgress(s, nowMs)) continue;
    const fill = Math.min(Math.max(num(s.fill_ratio, 0.8), 0.01), 1);
    const left = Math.min(s.max_sites - s.site_count, Math.floor(s.max_sites * Math.max(0, fill - shardHardLoad(s))));
    if (left <= 0) continue;
    have++;
    spare += left;
  }
  const need = (demand > 0 ? Math.ceil(demand / DEFAULT_SITES_PER_SHARD) : 0) + 1;
  return { demand_sites: demand, need, have, spare_sites: spare, short: have < need || spare < demand };
}

export type AutoProvSettings = {
  enabled: boolean;
  thresholdPct: number;
  maxPerDay: number;
  region: string;
  dryRun: boolean;
};

export async function autoProvSettingsFromStore(): Promise<AutoProvSettings> {
  const { getBoolSetting, getNumberSetting, getStringSetting } = await import("@/services/settings");
  const [enabled, threshold, max, region, dryRun] = await Promise.all([
    getBoolSetting("site_shard_auto_provision"),
    getNumberSetting("site_shard_auto_threshold"),
    getNumberSetting("site_shard_auto_max_per_day"),
    getStringSetting("site_shard_auto_region"),
    getBoolSetting("site_shard_auto_dry_run"),
  ]);
  return { enabled: enabled === true, thresholdPct: threshold, maxPerDay: max, region, dryRun: dryRun === true };
}

export function normalizeSettings(s: AutoProvSettings): AutoProvSettings {
  const region = /^[a-z]{2}-[a-z]+-[0-9]$/.test(s.region) ? s.region : "us-west-1";
  return {
    enabled: s.enabled === true,
    thresholdPct: Math.min(Math.max(num(s.thresholdPct, 20), 1), 90),
    maxPerDay: Math.min(Math.max(Math.floor(num(s.maxPerDay, 10)), 0), 10),
    region,
    dryRun: s.dryRun === true,
  };
}

export function autoProvisionAllowed(env: Record<string, string | undefined> = process.env): { ok: boolean; reason?: string } {
  if (env.PRAXIS_CONTAINER_ROLE === "probe") return { ok: false, reason: "probe_container" };
  if (env.PRAXIS_CONTAINER_ROLE !== "canonical") return { ok: false, reason: "not_deployed_backend" };
  if (env.NODE_ENV !== "production") return { ok: false, reason: "not_production" };
  return { ok: true };
}

export type Claim =
  | { action: "create"; ledger_id: string; day: string; seq: number; shard_name: string; n: number; region: string; canary: boolean; created_today: number; purpose?: ShardPurpose }
  | { action: "resume"; ledger_id: string; day: string; seq: number; shard_name: string; region: string; canary: boolean; purpose?: ShardPurpose }
  | { action: "none"; reason: "paused" | "in_progress_manual" | "backoff" | "cap"; shard_name?: string; created_today?: number; cap?: number; paused_reason?: string };

export type FinishResult = { status: string; consecutive_failures: number; paused: boolean; tripped: boolean; already: boolean };

export type AutoProvState = {
  env: ShardEnv;
  paused: boolean;
  paused_reason: string | null;
  paused_by: string | null;
  consecutive_failures: number;
  last_attempt_at: string | null;
};

export type AutoProvStatus = { state: AutoProvState; day: string; created_today: number; ledger: Array<Record<string, unknown>> };

export interface AutoProvStore {
  claim(input: { env: ShardEnv; source: "auto" | "staff"; maxPerDay: number; override: boolean; actor: string | null; region: string; minRetrySeconds: number; purpose?: ShardPurpose }): Promise<Claim>;
  finish(ledger_id: string, status: "open" | "ready" | "blocked" | "failed", reason: string | null): Promise<FinishResult>;
  setPaused(env: ShardEnv, paused: boolean, actor: string, reason: string | null): Promise<AutoProvState>;
  status(env: ShardEnv, limit?: number): Promise<AutoProvStatus>;
  notice(env: ShardEnv, key: string): Promise<boolean>;
}

type Rpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;

export function createAutoProvStore(rpc?: Rpc): AutoProvStore {
  const call = async (name: string, args: Record<string, unknown>) => {
    const fn: Rpc = rpc ?? (async (n, a) => (await import("@/services/tenant-client")).siteShardRpc(n, a) as unknown as ReturnType<Rpc>);
    const { data, error } = await fn(name, args);
    if (error) throw new Error(`autoprov: ${name} failed${error.code ? ` (${error.code})` : ""}: ${error.message ?? "unknown"}`);
    return data;
  };
  return {
    async claim(i) {
      return (await call("site_shard_autoprov_claim", {
        p_env: i.env, p_source: i.source, p_max_per_day: i.maxPerDay, p_override: i.override, p_actor: i.actor, p_region: i.region, p_min_retry_seconds: i.minRetrySeconds,
        ...(i.purpose === "validation" ? { p_purpose: "validation" } : {}),
      })) as Claim;
    },
    async finish(ledger_id, status, reason) {
      return (await call("site_shard_autoprov_finish", { p_ledger_id: ledger_id, p_status: status, p_reason: reason })) as FinishResult;
    },
    async setPaused(env, paused, actor, reason) {
      const d = await call("site_shard_autoprov_set_paused", { p_env: env, p_paused: paused, p_actor: actor, p_reason: reason });
      return (Array.isArray(d) ? d[0] : d) as AutoProvState;
    },
    async status(env, limit = 20) {
      return (await call("site_shard_autoprov_status", { p_env: env, p_limit: limit })) as AutoProvStatus;
    },
    async notice(env, key) {
      return (await call("site_shard_autoprov_notice", { p_env: env, p_key: key.slice(0, 200) })) === true;
    },
  };
}

export type ProvisionEventData = {
  env: ShardEnv;
  ledger_id: string;
  shard_name: string;
  n: number;
  region: string;
  canary: boolean;
  source: "auto" | "staff";
  purpose?: ShardPurpose;
};

export type ProvisionEvent = { id: string; name: typeof SHARD_PROVISION_EVENT; data: ProvisionEventData };

const shardNumber = (name: string) => Number(/-([0-9]{1,6})$/.exec(name)?.[1] ?? NaN);

export function provisionEvent(env: ShardEnv, claim: Extract<Claim, { action: "create" | "resume" }>, source: "auto" | "staff"): ProvisionEvent {
  return {
    id: `site-shard-provision:${env}:${claim.day}:${claim.seq}`,
    name: SHARD_PROVISION_EVENT,
    data: {
      env, ledger_id: claim.ledger_id, shard_name: claim.shard_name, n: shardNumber(claim.shard_name), region: claim.region, canary: claim.canary, source,
      ...(claim.purpose === "validation" ? { purpose: "validation" as const } : {}),
    },
  };
}

export type AlertFn = (code: string, msg: string) => Promise<void>;

export type CheckDeps = {
  env: ShardEnv;
  allowed: () => { ok: boolean; reason?: string };
  listShards: (env: ShardEnv) => Promise<ShardLoadRow[]>;
  capacityInputs?: (env: ShardEnv) => Promise<ShardCapacityInputs>;
  settings: () => Promise<AutoProvSettings>;
  prereqsMissing: () => string[];
  store: AutoProvStore;
  send: (event: ProvisionEvent) => Promise<void>;
  alert: AlertFn;
  log?: (line: string) => void;
  now?: () => number;
};

export type CheckResult =
  | { action: "skipped"; reason: string }
  | { action: "ok"; headroom: number; open: number }
  | { action: "alert_only"; reason: string; headroom: number; open: number }
  | { action: "dry_run"; headroom: number; open: number; would: string }
  | { action: "none"; reason: string; headroom: number; open: number }
  | { action: "enqueued"; kind: "create" | "resume"; shard_name: string; headroom: number; open: number };

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

function nextFreeName(env: ShardEnv, rows: ShardLoadRow[]): string {
  let max = 0;
  for (const s of rows) if (isNumberedShard(s)) max = Math.max(max, shardNumber(s.name) || 0);
  return `zavi-shard-${env}-${max + 1}`;
}

export async function capacityCheck(deps: CheckDeps): Promise<CheckResult> {
  const log = deps.log ?? ((l: string) => console.warn(l));
  try {
    return await check(deps, log);
  } catch (e) {
    log(`[site-shards] auto-provision check failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    return { action: "skipped", reason: "check_failed" };
  }
}

async function check(deps: CheckDeps, log: (l: string) => void): Promise<CheckResult> {
  const env = deps.env;
  const guard = deps.allowed();
  if (!guard.ok) return { action: "skipped", reason: guard.reason ?? "not_allowed" };

  const rows = await deps.listShards(env);
  const nowMs = (deps.now ?? Date.now)();
  const { open, headroom, stale } = envHeadroom(rows, { nowMs });
  const settings = normalizeSettings(await deps.settings());
  const provisioning = rows.some((s) => isNumberedShard(s) && s.state === "provisioning");
  let inputs: ShardCapacityInputs = { placements_1h: 0, placements_24h: 0, lead_time_s: null };
  if (deps.capacityInputs) {
    try {
      inputs = await deps.capacityInputs(env);
    } catch (e) {
      log(`[site-shards] capacity inputs unreadable (warm target from a zero rate): ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }
  const warm = warmTarget(rows, inputs, nowMs);
  const day = utcDay(nowMs);
  const line = `${env}: ${open} open shard(s), headroom ${pct(headroom)} (threshold ${settings.thresholdPct}%), warm ${warm.have}/${warm.need} (${warm.spare_sites} spare sites for ${warm.demand_sites} expected)${stale ? `, ${stale} with stale metrics` : ""}`;
  log(`[site-shards] auto-provision ${line}${provisioning ? ", one provisioning" : ""}`);
  const blindOpen = rows.filter((s) => isPooledShard(s) && s.state === "open" && !!s.project_ref && staleSources(s, nowMs).length > 0);
  const blind = blindOpen.length > 0;
  const low = !blind && (open === 0 || headroom < settings.thresholdPct / 100 || warm.short);

  const once = async (key: string, code: string, msg: string) => {
    if (await deps.store.notice(env, `${key}:${day}`)) await deps.alert(code, msg);
  };

  if (blind && !provisioning) {
    await once("blind", "sites.shards.auto_blind", `shared site database capacity is UNKNOWN (${line}): open shard(s) ${blindOpen.map((s) => s.name).join(", ")} have stale metrics, so placement treats them as full. Not provisioning blind; fix the metrics sweep (site-shards-metrics).`);
    return { action: "alert_only", reason: "metrics_stale", headroom, open };
  }
  if (!low && !provisioning) return { action: "ok", headroom, open };

  if (!settings.enabled) {
    if (!low) return { action: "ok", headroom, open };
    await once("off", "sites.shards.auto_off", `shared site database capacity is low (${line}) and auto-provisioning is OFF (site_shard_auto_provision); create one from admin > Site shards or the CLI`);
    return { action: "alert_only", reason: "setting_off", headroom, open };
  }
  const missing = deps.prereqsMissing();
  if (missing.length) {
    await once("prereqs", "sites.shards.auto_blocked", `shared site database capacity is low (${line}) but auto-provisioning cannot run: missing ${missing.join(", ")}`);
    return { action: "alert_only", reason: "prereqs_missing", headroom, open };
  }
  if (settings.dryRun) {
    const would = provisioning ? "resume the shard already provisioning" : `create ${nextFreeName(env, rows)} in ${settings.region}`;
    await once("dry_run", "sites.shards.auto_dry_run", `DRY RUN: shared site database capacity is low (${line}); auto-provisioning would ${would}`);
    return { action: "dry_run", headroom, open, would };
  }

  const claim = await deps.store.claim({
    env, source: "auto", maxPerDay: settings.maxPerDay, override: false, actor: null, region: settings.region, minRetrySeconds: RETRY_BASE_SECONDS,
  });
  if (claim.action === "none") {
    if (claim.reason === "cap") {
      await once("cap", "sites.shards.auto_cap", `shared site database daily cap hit: ${claim.created_today ?? "?"} of ${claim.cap ?? settings.maxPerDay} new shards today (${line}); nothing more is created until tomorrow (UTC) unless staff override`);
    } else if (claim.reason === "paused") {
      await once("paused", "sites.shards.auto_paused", `shared site database capacity is low (${line}) and auto-provisioning is PAUSED (${claim.paused_reason ?? "staff"}); resume it in admin > Site shards`);
    } else if (claim.reason === "in_progress_manual") {
      await once("manual", "sites.shards.auto_waiting", `auto-provisioning is waiting: ${claim.shard_name} is being provisioned by hand (CLI) and is not finished (${line})`);
    }
    return { action: "none", reason: claim.reason, headroom, open };
  }
  await deps.send(provisionEvent(env, claim, "auto"));
  if (claim.action === "create") {
    await deps.alert(
      "sites.shards.auto_create",
      `creating shared site database ${claim.shard_name} in ${claim.region}${claim.canary ? " (canary)" : ""}: ${open === 0 ? "no shard is open" : headroom < settings.thresholdPct / 100 ? `headroom ${pct(headroom)} < ${settings.thresholdPct}%` : `warm shards ${warm.have} < ${warm.need}, or ${warm.spare_sites} spare sites < ${warm.demand_sites} expected during a ${Math.round((inputs.lead_time_s ?? DEFAULT_LEAD_TIME_S) / 60)}-min provisioning lead time`} (${env}). A paid Supabase project (about $10/month). ${claim.created_today} of ${settings.maxPerDay} today.`,
    );
  } else {
    log(`[site-shards] auto-provision: resuming ${claim.shard_name}`);
  }
  return { action: "enqueued", kind: claim.action, shard_name: claim.shard_name, headroom, open };
}

export type StaffRequestResult =
  | { ok: true; action: "create" | "resume"; shard_name: string; cap_override: boolean }
  | { ok: true; action: "dry_run"; would: string }
  | { ok: false; code: "not_deployed_backend" | "prereqs_missing" | "in_progress_manual" | "cap" | "backoff" | "paused"; message: string };

export async function requestProvision(
  deps: CheckDeps,
  input: { actor: string; override: boolean },
): Promise<StaffRequestResult> {
  const guard = deps.allowed();
  if (!guard.ok) return { ok: false, code: "not_deployed_backend", message: `only the deployed backend creates shards (${guard.reason})` };
  const missing = deps.prereqsMissing();
  if (missing.length) return { ok: false, code: "prereqs_missing", message: `missing ${missing.join(", ")}` };
  const settings = normalizeSettings(await deps.settings());
  if (settings.dryRun) {
    const rows = await deps.listShards(deps.env);
    return { ok: true, action: "dry_run", would: rows.some((s) => isNumberedShard(s) && s.state === "provisioning") ? "resume the shard already provisioning" : `create ${nextFreeName(deps.env, rows)}` };
  }
  const claim = await deps.store.claim({
    env: deps.env, source: "staff", maxPerDay: settings.maxPerDay, override: input.override, actor: input.actor, region: settings.region, minRetrySeconds: 0,
  });
  if (claim.action === "none") {
    const message =
      claim.reason === "cap" ? `daily cap reached (${claim.created_today ?? "?"}/${claim.cap ?? settings.maxPerDay}); pass override_cap with a reason to create one more`
      : claim.reason === "in_progress_manual" ? `${claim.shard_name} is being provisioned by hand; finish it with the CLI first`
      : claim.reason;
    if (claim.reason === "cap") {
      await deps.alert("sites.shards.auto_cap", `shared site database daily cap hit on a staff request by ${input.actor} (${claim.created_today ?? "?"}/${claim.cap ?? settings.maxPerDay})`);
    }
    return { ok: false, code: claim.reason, message };
  }
  await deps.send(provisionEvent(deps.env, claim, "staff"));
  const override = input.override && claim.action === "create";
  await deps.alert(
    "sites.shards.auto_create",
    claim.action === "create"
      ? `staff ${input.actor} is creating shared site database ${claim.shard_name} in ${claim.region}${override ? " WITH a daily-cap override" : ""}: a paid Supabase project (about $10/month)`
      : `staff ${input.actor} resumed provisioning ${claim.shard_name}`,
  );
  return { ok: true, action: claim.action, shard_name: claim.shard_name, cap_override: override };
}

export type RecoveryDeps = {
  allowed: () => { ok: boolean; reason?: string };
  listProjectsByName: (name: string) => Promise<Array<{ ref: string }>>;
  adoptRef: (name: string, ref: string) => Promise<void>;
  recover: (name: string, found: 0 | 1, actor: string) => Promise<{ create_state: string }>;
  alert: AlertFn;
};

export type RecoverResult =
  | { ok: true; outcome: "adopted"; ref: string; create_state: string }
  | { ok: true; outcome: "none_found"; create_state: string }
  | { ok: false; code: "not_deployed_backend" | "bad_name" | "duplicates" | "refused"; message: string };

export async function staffRecover(deps: RecoveryDeps, name: string, actor: string): Promise<RecoverResult> {
  const g = deps.allowed();
  if (!g.ok) return { ok: false, code: "not_deployed_backend", message: `only the deployed backend recovers shards (${g.reason})` };
  if (!/^zavi-shard-(prod|dev)-[0-9]{1,6}$/.test(name)) return { ok: false, code: "bad_name", message: "not a numbered shard name" };
  const found = await deps.listProjectsByName(name);
  if (found.length > 1) {
    return { ok: false, code: "duplicates", message: `${found.length} projects are named ${name} (${found.map((p) => p.ref).join(", ")}); delete the extras in the Supabase dashboard, then recover again` };
  }
  try {
    if (found[0]) await deps.adoptRef(name, found[0].ref);
    const r = await deps.recover(name, found.length as 0 | 1, actor);
    await deps.alert(
      "sites.shards.auto_recovered",
      `staff ${actor} recovered ${name}: ${found[0] ? `adopted project ${found[0].ref}` : "no project by that name; one create is allowed after the settle period"}`,
    ).catch(() => undefined);
    return found[0] ? { ok: true, outcome: "adopted", ref: found[0].ref, create_state: r.create_state } : { ok: true, outcome: "none_found", create_state: r.create_state };
  } catch (e) {
    return { ok: false, code: "refused", message: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}

export async function productionRecoveryDeps(): Promise<RecoveryDeps> {
  const [{ shardRegistry, shardEnv }, { createShardMgmt }] = await Promise.all([import("./registry"), import("./shard-mgmt")]);
  const rpc = async (n: string, a: Record<string, unknown>) => {
    const { data, error } = await (await import("@/services/tenant-client")).siteShardRpc(n, a);
    if (error) throw new Error(`${n} failed: ${error.message ?? "unknown"}`);
    return data;
  };
  return {
    allowed: () => autoProvisionAllowed(),
    listProjectsByName: (name) => createShardMgmt().listProjectsByName(name),
    adoptRef: async (name, ref) => {
      const reg = shardRegistry();
      const row = (await reg.list(shardEnv())).find((s) => s.name === name);
      if (!row) throw new Error(`${name} is not in this env's registry`);
      if (row.project_ref === ref) return;
      if (row.project_ref) throw new Error(`${name} already points at ${row.project_ref}, not ${ref}`);
      await reg.update(row.id, { project_ref: ref, url: `https://${ref}.supabase.co` });
    },
    recover: async (name, found, actor) => {
      const d = await rpc("site_shard_guard_staff_recover", { p_name: name, p_found: found, p_actor: actor });
      return (Array.isArray(d) ? d[0] : d) as { create_state: string };
    },
    alert: productionAlert,
  };
}

export type AttemptOutcome =
  | { status: "open" | "ready"; shard: string }
  | { status: "blocked"; shard: string; step: string; reason: string }
  | { status: "failed"; shard: string; reason: string };

export type JobDeps = {
  allowed: () => { ok: boolean; reason?: string };
  stillWanted: (data: ProvisionEventData) => Promise<string | null>;
  provision: (input: { env: ShardEnv; n: number; region: string; canary?: boolean; open?: boolean; healthPolls?: number; holder?: string; source?: "auto" | "staff" }) => Promise<
    { status: "open" | "ready"; shard: { name: string } } | { status: "blocked"; shard: { name: string }; step: string; reason: string }
  >;
  store: AutoProvStore;
  alert: AlertFn;
  afterOpen?: () => Promise<void>;
  log?: (line: string) => void;
};

export async function provisionAttempt(deps: JobDeps, data: ProvisionEventData, healthPolls: number): Promise<AttemptOutcome | { status: "refused"; reason: string }> {
  const guard = deps.allowed();
  if (!guard.ok) return { status: "refused", reason: guard.reason ?? "not_allowed" };
  if (!/^zavi-shard-(prod|dev)-[0-9]{1,6}$/.test(data.shard_name) || data.shard_name !== `zavi-shard-${data.env}-${data.n}`) {
    return { status: "failed", shard: String(data.shard_name), reason: "bad event: shard name does not match env and number" };
  }
  let stop: string | null;
  try {
    stop = await deps.stillWanted(data);
  } catch {
    stop = "state_unreadable";
  }
  if (stop) return { status: "refused", reason: stop };
  try {
    const r = await deps.provision({ env: data.env, n: data.n, region: data.region, canary: data.canary, open: data.purpose !== "validation", healthPolls, holder: `job:${data.ledger_id}`, source: data.source });
    if (r.status === "blocked") {
      const g = guardRefusal(r.step, r.reason);
      if (g) return guardOutcome(deps, data, g.code, r.reason);
      return { status: "blocked", shard: r.shard.name, step: r.step, reason: r.reason };
    }
    return { status: r.status, shard: r.shard.name };
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "ShardProvisionBusy") return { status: "refused", reason: "lease_busy" };
    if (name === "ShardNeedsStaff") return guardOutcome(deps, data, "needs_staff", String((e as Error).message));
    return { status: "failed", shard: data.shard_name, reason: String((e as Error)?.message ?? e).slice(0, 400) };
  }
}

export function guardRefusal(step: string, reason: string): { code: string } | null {
  const m = step === "project" ? /^guard:([a-z_]+)/.exec(reason) : null;
  return m ? { code: m[1] } : null;
}

async function guardOutcome(deps: JobDeps, data: ProvisionEventData, code: string, reason: string): Promise<{ status: "refused"; reason: string }> {
  const alertCodes: Record<string, string> = {
    uncertain: "sites.shards.auto_create_uncertain",
    needs_staff: "sites.shards.auto_needs_staff",
    duplicates: "sites.shards.auto_needs_staff",
  };
  const ac = alertCodes[code];
  if (ac) {
    const fresh = code === "uncertain" ? true : await deps.store.notice(data.env, `guard:${data.shard_name}:${code}`).catch(() => true);
    if (fresh) {
      await deps.alert(
        ac,
        code === "uncertain"
          ? `provisioning ${data.shard_name}: ${reason.replace(/^guard:uncertain: /, "")}. No second create: after 10 min the org is listed by the shard's name and a found project is adopted; only if none exists is ONE retry allowed.`
          : `provisioning ${data.shard_name} is STOPPED for staff recovery: ${reason}. Recover it in admin > Site shards (it lists the org's projects by this name and adopts one if found).`,
      ).catch(() => undefined);
    }
  } else {
    (deps.log ?? ((l: string) => console.warn(l)))(`[site-shards] auto-provision ${data.shard_name}: waiting (${reason})`);
  }
  return { status: "refused", reason: `guard:${code}` };
}

export async function jobStillWanted(
  data: ProvisionEventData,
  read: { settings: () => Promise<AutoProvSettings>; status: (env: ShardEnv) => Promise<AutoProvStatus> },
): Promise<string | null> {
  const s = normalizeSettings(await read.settings());
  if (s.dryRun) return "dry_run";
  if (data.source === "staff") return null;
  if (!s.enabled) return "setting_off";
  if ((await read.status(data.env)).state.paused) return "paused";
  return null;
}

export async function finishProvision(deps: JobDeps, data: ProvisionEventData, outcome: AttemptOutcome): Promise<FinishResult> {
  const log = deps.log ?? ((l: string) => console.warn(l));
  const reason = outcome.status === "blocked" ? `${outcome.step}: ${outcome.reason}` : outcome.status === "failed" ? outcome.reason : null;
  const fin = await deps.store.finish(data.ledger_id, outcome.status, reason);
  log(`[site-shards] auto-provision ${data.shard_name}: ${outcome.status}${reason ? ` (${reason})` : ""}; failures in a row=${fin.consecutive_failures}`);
  if (fin.already) return fin;
  if (outcome.status === "open" && deps.afterOpen) {
    await deps.afterOpen().catch((e: unknown) => log(`[site-shards] metrics after opening ${data.shard_name}: ${String((e as Error)?.message ?? e).slice(0, 200)}`));
  }
  if (outcome.status === "open" || outcome.status === "ready") {
    await deps.alert(
      "sites.shards.auto_done",
      data.purpose === "validation"
        ? `validation database ${data.shard_name} is ready for publish-gate test sites (never placeable for customer sites) (${data.env}, ${data.source})`
        : `shared site database ${data.shard_name} is ${outcome.status === "open" ? "OPEN and taking new sites" : "provisioned (not opened)"} (${data.env}, ${data.source})`,
    );
  } else {
    await deps.alert(
      "sites.shards.auto_failed",
      `provisioning shared site database ${data.shard_name} ${outcome.status === "blocked" ? "is BLOCKED" : "FAILED"}: ${reason}. ${fin.paused ? "" : "It is retried (the same project, never a new one) on a later hourly check."}`,
    );
  }
  if (fin.tripped) {
    await deps.alert(
      "sites.shards.auto_breaker",
      `auto-provisioning PAUSED (${data.env}): ${fin.consecutive_failures} provisioning attempts failed in a row (last: ${data.shard_name}: ${reason}). Fix the cause, then resume it in admin > Site shards.`,
    );
  }
  return fin;
}

export async function productionAlert(code: string, msg: string): Promise<void> {
  const { alert } = await import("@/services/logging/alert");
  await alert({ msg, source: AUTO_SOURCE, code });
}

export async function productionCheckDeps(): Promise<CheckDeps> {
  const [{ shardEnv, shardRegistry }, { provisionPrereqsMissing }] = await Promise.all([
    import("./registry"),
    import("./provision-run"),
  ]);
  return {
    env: shardEnv(),
    allowed: () => autoProvisionAllowed(),
    listShards: async (env) => (await shardRegistry().list(env)) as unknown as ShardLoadRow[],
    capacityInputs: (env) => shardRegistry().capacityInputs(env),
    settings: autoProvSettingsFromStore,
    prereqsMissing: () => provisionPrereqsMissing(),
    store: createAutoProvStore(),
    send: async (event) => {
      const { inngest } = await import("@/../workers/client");
      await inngest.send(event);
    },
    alert: productionAlert,
    log: (l) => console.warn(l),
  };
}

export async function productionJobDeps(): Promise<JobDeps> {
  const { runProvisionShard } = await import("./provision-run");
  const store = createAutoProvStore();
  return {
    allowed: () => autoProvisionAllowed(),
    stillWanted: (data) => jobStillWanted(data, { settings: autoProvSettingsFromStore, status: (env) => store.status(env, 1) }),
    provision: ({ source, ...input }) =>
      runProvisionShard({
        ...input,
        gate: {
          source: source ?? "auto",
          enabled: async () => {
            const { getBoolSettingStrictResolved } = await import("@/services/settings");
            const [on, dry] = await Promise.all([
              getBoolSettingStrictResolved("site_shard_auto_provision", GLOBAL_SETTING_TENANT),
              getBoolSettingStrictResolved("site_shard_auto_dry_run", GLOBAL_SETTING_TENANT),
            ]);
            return on && !dry;
          },
          maxPerDay: async () => normalizeSettings(await autoProvSettingsFromStore()).maxPerDay,
        },
      }),
    store,
    alert: productionAlert,
    afterOpen: async () => {
      await (await import("./metrics")).runShardMetricsSweep();
    },
    log: (l) => console.warn(l),
  };
}

export async function runCapacityCheck(): Promise<CheckResult> {
  if (!autoProvisionAllowed().ok) return { action: "skipped", reason: autoProvisionAllowed().reason ?? "not_allowed" };
  return capacityCheck(await productionCheckDeps());
}
