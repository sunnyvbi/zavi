
import {
  isPooledShard,
  isValidationShard,
  normalizeSettings,
  provisionEvent,
  RETRY_BASE_SECONDS,
  shardHardLoad,
  isNumberedShard,
  type CheckDeps,
  type ShardLoadRow,
} from "./autoprovision";
import { PROVISION_DONE } from "./contract";

export const VALIDATION_WARM_TARGET = 2;

export type ValidationRegionState = { region: string; serving: number; warm: number; target: number };

export type ValidationCheckResult =
  | { action: "skipped"; reason: string }
  | { action: "ok"; regions: ValidationRegionState[] }
  | { action: "alert_only"; reason: string; regions: ValidationRegionState[] }
  | { action: "dry_run"; would: string; regions: ValidationRegionState[] }
  | { action: "none"; reason: string; regions: ValidationRegionState[] }
  | { action: "enqueued"; kind: "create" | "resume"; shard_name: string; region: string; regions: ValidationRegionState[] };

const REGION_RE = /^[a-z]{2}-[a-z]+-[0-9]$/;
const num = (v: unknown, d: number) => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export function isWarmValidation(s: ShardLoadRow & { provision_step?: string | null }): boolean {
  if (!isValidationShard(s) || s.state !== "full" || !s.project_ref) return false;
  if ((s.provision_step ?? PROVISION_DONE) !== PROVISION_DONE) return false;
  return s.site_count < s.max_sites && shardHardLoad(s) < Math.min(Math.max(num(s.fill_ratio, 0.8), 0.01), 1);
}

export function validationRegions(rows: Array<ShardLoadRow & { provision_step?: string | null }>, configuredRegion: string): ValidationRegionState[] {
  const regions = new Set<string>();
  if (REGION_RE.test(configuredRegion)) regions.add(configuredRegion);
  for (const s of rows) {
    if (isPooledShard(s) && s.project_ref && (s.state === "open" || s.state === "full") && s.region && REGION_RE.test(s.region)) regions.add(s.region);
  }
  return [...regions].sort().map((region) => {
    const mine = rows.filter((s) => isValidationShard(s) && s.region === region);
    return {
      region,
      serving: mine.filter((s) => s.state === "full").length,
      warm: mine.filter((s) => isWarmValidation(s)).length,
      target: VALIDATION_WARM_TARGET,
    };
  });
}

export async function validationCapacityCheck(deps: CheckDeps): Promise<ValidationCheckResult> {
  const log = deps.log ?? ((l: string) => console.warn(l));
  try {
    return await check(deps, log);
  } catch (e) {
    log(`[site-shards] validation capacity check failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    return { action: "skipped", reason: "check_failed" };
  }
}

async function check(deps: CheckDeps, log: (l: string) => void): Promise<ValidationCheckResult> {
  const env = deps.env;
  const guard = deps.allowed();
  if (!guard.ok) return { action: "skipped", reason: guard.reason ?? "not_allowed" };

  const rows = (await deps.listShards(env)) as Array<ShardLoadRow & { provision_step?: string | null }>;
  const settings = normalizeSettings(await deps.settings());
  const regions = validationRegions(rows, settings.region);
  const short = regions.filter((r) => r.warm < r.target);
  const summary = regions.map((r) => `${r.region}: ${r.warm}/${r.target} warm (${r.serving} serving)`).join("; ") || "no region";
  log(`[site-shards] validation capacity ${env}: ${summary}`);
  if (!short.length) return { action: "ok", regions };

  if (rows.some((s) => isNumberedShard(s) && s.state === "provisioning")) {
    return { action: "none", reason: "in_progress", regions };
  }
  const want = short[0];
  const day = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
  const once = async (key: string, code: string, msg: string) => {
    if (await deps.store.notice(env, `validation:${key}:${day}`)) await deps.alert(code, msg);
  };
  const line = `${env} ${want.region}: ${want.warm} of ${want.target} warm validation shard(s)`;

  if (!settings.enabled) {
    await once("off", "sites.shards.validation_off", `publish-gate validation capacity is short (${line}) and auto-provisioning is OFF (site_shard_auto_provision); gates in this region wait or fail until one is created`);
    return { action: "alert_only", reason: "setting_off", regions };
  }
  const missing = deps.prereqsMissing();
  if (missing.length) {
    await once("prereqs", "sites.shards.validation_blocked", `publish-gate validation capacity is short (${line}) but provisioning cannot run: missing ${missing.join(", ")}`);
    return { action: "alert_only", reason: "prereqs_missing", regions };
  }
  if (settings.dryRun) {
    const would = `create a validation shard in ${want.region}`;
    await once("dry_run", "sites.shards.validation_dry_run", `DRY RUN: publish-gate validation capacity is short (${line}); auto-provisioning would ${would}`);
    return { action: "dry_run", would, regions };
  }

  const claim = await deps.store.claim({
    env, source: "auto", maxPerDay: settings.maxPerDay, override: false, actor: null, region: want.region, minRetrySeconds: RETRY_BASE_SECONDS, purpose: "validation",
  });
  if (claim.action === "none") {
    if (claim.reason === "cap") {
      await once("cap", "sites.shards.validation_cap", `publish-gate validation capacity is short (${line}) and today's shard cap is used (${claim.created_today ?? "?"}/${claim.cap ?? settings.maxPerDay})`);
    } else if (claim.reason === "paused") {
      await once("paused", "sites.shards.validation_paused", `publish-gate validation capacity is short (${line}) and auto-provisioning is PAUSED (${claim.paused_reason ?? "staff"})`);
    }
    return { action: "none", reason: claim.reason, regions };
  }
  await deps.send(provisionEvent(env, claim, "auto"));
  if (claim.action === "create") {
    if (claim.purpose !== "validation") throw new Error(`validation claim returned a ${claim.purpose ?? "pool"} shard`);
    await deps.alert(
      "sites.shards.validation_create",
      `creating validation database ${claim.shard_name} in ${claim.region} for publish-gate test sites (${line}). A paid Supabase project (about $10/month), never placeable for customer sites. ${claim.created_today} of ${settings.maxPerDay} today.`,
    );
  } else {
    log(`[site-shards] validation capacity: resuming ${claim.shard_name}`);
  }
  return { action: "enqueued", kind: claim.action, shard_name: claim.shard_name, region: claim.region, regions };
}

export async function runValidationCapacityCheck(): Promise<ValidationCheckResult> {
  const { autoProvisionAllowed, productionCheckDeps } = await import("./autoprovision");
  const g = autoProvisionAllowed();
  if (!g.ok) return { action: "skipped", reason: g.reason ?? "not_allowed" };
  return validationCapacityCheck(await productionCheckDeps());
}
