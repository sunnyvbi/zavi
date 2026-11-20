
import { createHash } from "node:crypto";
import type { ShardEnv, ShardRow } from "./contract";
import type { ShardMigrationFile } from "./migrations";
import type { ShardRegistry } from "./registry";
import { activePauseReason, rolloutOwnedPause, rolloutShardSchema, type RolloutDeps, type RolloutReport } from "./rollout";

export const SCHEMA_ROLLOUT_EVENT = "site-shards/schema-rollout.requested";
export const AUTO_CANARY_SOAK_MS = 60_000;
export const ALERT_EVERY_S = 6 * 3600;

export type AutoRolloutResult =
  | { action: "skipped"; reason: string }
  | { action: "up_to_date"; shards: number }
  | { action: "busy" }
  | { action: "rolled_out"; shards: Array<{ shard: string; applied: string[] }> }
  | { action: "failed"; error: string; report?: RolloutReport };

export type AutoRolloutDeps = Omit<RolloutDeps, "alert" | "registry"> & {
  registry: RolloutDeps["registry"] & Pick<ShardRegistry, "alertClaim">;
  env: ShardEnv;
  allowed: () => { ok: boolean; reason?: string };
  alert: (code: string, msg: string) => Promise<void>;
};

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

export function shardFilesFingerprint(files: ShardMigrationFile[]): string {
  const h = createHash("sha256");
  for (const f of files) h.update(`${f.version}:${f.sha256}\n`);
  return h.digest("hex").slice(0, 16);
}

export async function autoRolloutShardSchema(deps: AutoRolloutDeps): Promise<AutoRolloutResult> {
  const log = deps.log ?? (() => undefined);
  const allowed = deps.allowed();
  if (!allowed.ok) return { action: "skipped", reason: allowed.reason ?? "not_allowed" };
  try {
    const base: RolloutDeps = { ...deps, alert: undefined };
    const dry = await rolloutShardSchema(base, { env: deps.env, dryRun: true });
    const unreadable = dry.shards.filter((s) => s.status !== "dry_run");
    const pending = dry.shards.filter((s) => s.pending.length);
    const live = new Set(dry.shards.map((s) => s.shard));
    const stranded = (await deps.registry.list(deps.env)).filter(
      (r) => live.has(r.name) && rolloutOwnedPause(activePauseReason(r as ShardRow & { placement_paused_until?: string | null; placement_paused_reason?: string | null })),
    );
    if (!pending.length && !unreadable.length && !stranded.length) return { action: "up_to_date", shards: dry.shards.length };

    log(
      `[shard-auto-rollout] ${deps.env}: ${[
        ...pending.map((s) => `${s.shard} needs ${s.pending.join(",")}`),
        ...stranded.map((r) => `${r.name} left paused by a rollout`),
        ...unreadable.map((s) => `${s.shard} ledger unreadable`),
      ].join("; ")}`,
    );
    const report = await rolloutShardSchema(base, { env: deps.env, quarantine: true });
    if (!report.ok && report.error && report.shards.every((s) => s.status === "skipped")) {
      log(`[shard-auto-rollout] ${deps.env}: ${report.error}`);
      return { action: "busy" };
    }
    if (report.ok) {
      const done = report.shards.filter((s) => s.applied.length).map((s) => ({ shard: s.shard, applied: s.applied }));
      log(`[shard-auto-rollout] ${deps.env}: ok ${JSON.stringify(done)}`);
      return { action: "rolled_out", shards: done };
    }
    await alertFailure(deps, report);
    return { action: "failed", error: describe(report), report };
  } catch (e) {
    const error = errText(e);
    log(`[shard-auto-rollout] ${deps.env}: ${error}`);
    const first = await deps.registry
      .list(deps.env)
      .then((rows) => rows[0] ?? null)
      .catch(() => null);
    const page = first
      ? await deps.registry.alertClaim(first.id, "schema_auto_rollout_error", ALERT_EVERY_S).catch(() => processThrottle(`error:${deps.env}`))
      : processThrottle(`error:${deps.env}`);
    if (page) await deps.alert("sites.shards.auto_rollout_failed", `automatic shard schema rollout (${deps.env}) could not run: ${error}`).catch(() => undefined);
    return { action: "failed", error };
  }
}

const lastPage = new Map<string, number>();
export function processThrottle(key: string, nowMs = Date.now()): boolean {
  const last = lastPage.get(key);
  if (last !== undefined && nowMs - last < ALERT_EVERY_S * 1000) return false;
  lastPage.set(key, nowMs);
  return true;
}

function describe(report: RolloutReport): string {
  const bad = report.shards.find((s) => s.status === "failed" || s.status === "canary_unhealthy");
  if (!bad) return report.error ?? "rollout failed";
  return `${bad.shard}: ${bad.status === "canary_unhealthy" ? "canary unhealthy after its files" : bad.error ?? "failed"}`;
}

async function alertFailure(deps: AutoRolloutDeps, report: RolloutReport): Promise<void> {
  const bad = report.shards.find((s) => s.status === "failed" || s.status === "canary_unhealthy");
  const quarantined = report.shards.filter((s) => s !== bad && s.quarantined && s.paused !== false).map((s) => s.shard);
  const msg =
    `automatic shard schema rollout (${deps.env}) STOPPED: ${describe(report)}. ` +
    `${bad && (bad.paused || bad.held_pause) ? `${bad.shard} takes no new sites until it is fixed. ` : ""}` +
    `${quarantined.length ? `Also paused (lacking schema files): ${quarantined.join(", ")}. ` : ""}` +
    "It retries every hour; publishes on an unmigrated shard fail (retryable) until it succeeds.";
  try {
    const row = bad ? (await deps.registry.list(deps.env)).find((r) => r.name === bad.shard) : undefined;
    if (row && !(await deps.registry.alertClaim(row.id, "schema_auto_rollout_failed", ALERT_EVERY_S))) return;
  } catch {
  }
  await deps.alert("sites.shards.rollout_failed", msg).catch(() => undefined);
}

export async function runAutoSchemaRollout(): Promise<AutoRolloutResult> {
  try {
    const [{ shardRegistry, shardEnv }, { createShardMgmt }, { loadShardMigrations }, { autoProvisionAllowed, productionAlert }] = await Promise.all([
      import("./registry"),
      import("./shard-mgmt"),
      import("./migrations"),
      import("./autoprovision"),
    ]);
    const allowed = autoProvisionAllowed();
    if (!allowed.ok) return { action: "skipped", reason: allowed.reason ?? "not_allowed" };
    const registry = shardRegistry();
    let mgmt: ReturnType<typeof createShardMgmt> | null = null;
    return await autoRolloutShardSchema({
      registry,
      sql: { query: (ref, q) => (mgmt ??= createShardMgmt()).query(ref, q) },
      files: loadShardMigrations(),
      env: shardEnv(),
      allowed: () => allowed,
      canarySoakMs: AUTO_CANARY_SOAK_MS,
      alert: productionAlert,
      log: (l) => console.warn(l),
    });
  } catch (e) {
    const error = errText(e);
    console.error(`[shard-auto-rollout] could not start: ${error}`);
    if (processThrottle("start")) {
      await import("./autoprovision")
        .then((m) => m.productionAlert("sites.shards.auto_rollout_failed", `automatic shard schema rollout could not start: ${error}`))
        .catch(() => undefined);
    }
    return { action: "failed", error };
  }
}

export async function requestSchemaRollout(reason: string, dedupe: string): Promise<string | null> {
  try {
    const { inngest } = await import("@/../workers/client");
    await inngest.send({ name: SCHEMA_ROLLOUT_EVENT, id: `schema-rollout:${dedupe}`.slice(0, 200), data: { reason: reason.slice(0, 200) } });
    return null;
  } catch (e) {
    console.warn(`[shard-auto-rollout] could not request a rollout (${reason}): ${errText(e)}; the next hourly request is the backstop`);
    return errText(e);
  }
}

export async function requestHourlySchemaRollout(nowMs = Date.now()): Promise<{ requested: boolean; reason?: string }> {
  try {
    const [{ autoProvisionAllowed }, { shardEnv }] = await Promise.all([import("./autoprovision"), import("./registry")]);
    const allowed = autoProvisionAllowed();
    if (!allowed.ok) return { requested: false, reason: allowed.reason };
    const failed = await requestSchemaRollout("hourly", `${shardEnv()}:hourly:${new Date(nowMs).toISOString().slice(0, 13)}`);
    return failed ? { requested: false, reason: `send failed: ${failed}` } : { requested: true };
  } catch (e) {
    return { requested: false, reason: errText(e) };
  }
}

export async function requestSchemaRolloutOnBoot(): Promise<void> {
  try {
    const [{ autoProvisionAllowed }, { shardEnv }, { loadShardMigrations }] = await Promise.all([
      import("./autoprovision"),
      import("./registry"),
      import("./migrations"),
    ]);
    if (!autoProvisionAllowed().ok) return;
    const env = shardEnv();
    await requestSchemaRollout("deploy", `${env}:${shardFilesFingerprint(loadShardMigrations())}`);
  } catch (e) {
    console.warn(`[shard-auto-rollout] boot request skipped: ${errText(e)}`);
  }
}

export function requestSchemaRepair(shard_ref: string, version: string): void {
  const hour = new Date().toISOString().slice(0, 13);
  console.warn(`[shard-auto-rollout] shard ${shard_ref} lacks ${version}: requesting a schema rollout`);
  void import("./registry")
    .then(({ shardEnv }) => requestSchemaRollout(`missing ${version} on ${shard_ref}`, `${shardEnv()}:repair:${shard_ref}:${hour}`))
    .catch(() => undefined);
}
