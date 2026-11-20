
import { randomUUID } from "node:crypto";
import type { ShardEnv, ShardRow, ShardSql } from "./contract";
import { applyPendingMigrations, contractAfterOf, latestVersion, pendingMigrations, readLedger, type ShardMigrationFile } from "./migrations";
import { ROLLOUT_IN_PROGRESS } from "./metrics";
import type { ShardRegistry } from "./registry";

export type ShardRolloutEntry = {
  shard: string;
  canary: boolean;
  pending: string[];
  applied: string[];
  status: "dry_run" | "up_to_date" | "applied" | "failed" | "canary_unhealthy" | "skipped";
  paused?: boolean;
  held_pause?: string;
  quarantined?: boolean;
  error?: string;
};

export type RolloutReport = { ok: boolean; dry_run: boolean; shards: ShardRolloutEntry[]; error?: string };

export const ROLLOUT_LOCK_SECONDS = 6 * 3600;

export const ROLLOUT_PAUSE_REASON = ROLLOUT_IN_PROGRESS;
export const ROLLOUT_STOPPED = "schema rollout stopped";

export function rolloutOwnedPause(reason: string | null | undefined): boolean {
  const r = String(reason ?? "");
  return r.startsWith(ROLLOUT_IN_PROGRESS) || r.startsWith(ROLLOUT_STOPPED);
}

type PauseFields = { placement_paused_until?: string | null; placement_paused_reason?: string | null };

export function activePauseReason(row: PauseFields, nowMs = Date.now()): string | null {
  const until = row.placement_paused_until;
  if (!until) return null;
  const t = new Date(until).getTime();
  if (Number.isFinite(t) && t <= nowMs) return null;
  return String(row.placement_paused_reason ?? "") || "(no reason)";
}

export type RolloutDeps = {
  registry: Pick<ShardRegistry, "list" | "update" | "record" | "pausePlacement" | "resumePlacement" | "rolloutClaim" | "rolloutRelease"> &
    Partial<Pick<ShardRegistry, "get" | "pausePlacementUnlessHeld">>;
  sql: ShardSql;
  files: ShardMigrationFile[];
  verifyCanary?: (shard: ShardRow) => Promise<boolean>;
  canarySoakMs?: number;
  sleep?: (ms: number) => Promise<void>;
  alert?: (code: string, msg: string) => Promise<void>;
  log?: (line: string) => void;
};

export function rolloutOrder(shards: ShardRow[]): Array<{ shard: ShardRow; canary: boolean }> {
  const live = shards
    .filter((s) => s.state !== "retired" && s.state !== "provisioning" && !!s.project_ref)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
  const flagged = live.filter((s) => s.is_canary);
  const canaries = flagged.length ? flagged : live.slice(0, 1);
  const rest = live.filter((s) => !canaries.includes(s));
  return [...canaries.map((shard) => ({ shard, canary: true })), ...rest.map((shard) => ({ shard, canary: false }))];
}

export async function canaryHealthy(sql: ShardSql, shard: ShardRow, files: ShardMigrationFile[]): Promise<boolean> {
  const ref = shard.project_ref as string;
  const ok = (await sql.query(ref, "select 1 as ok")) as Array<{ ok?: unknown }>;
  if (Number(ok[0]?.ok) !== 1) return false;
  return pendingMigrations(files, await readLedger(sql, ref)).length === 0;
}

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

export function sameReleaseContracts(files: ShardMigrationFile[], pending: Set<string>): string[] {
  const out: string[] = [];
  for (const f of files) {
    const after = contractAfterOf(f);
    if (after && pending.has(f.version) && pending.has(after)) out.push(`${f.version} (contract) with its expand file ${after}`);
  }
  return out;
}

export type RolloutOptions = {
  env: ShardEnv;
  dryRun?: boolean;
  quarantine?: boolean;
};

export async function rolloutShardSchema(deps: RolloutDeps, opts: RolloutOptions): Promise<RolloutReport> {
  const log = deps.log ?? (() => undefined);
  const alert = async (code: string, msg: string) => {
    log(`[shard-rollout] ${msg}`);
    await deps.alert?.(code, msg).catch(() => undefined);
  };
  const order = rolloutOrder(await deps.registry.list(opts.env));
  if (opts.dryRun) return runRollout(deps, opts, order, alert, "");
  const holder = `rollout:${randomUUID()}`;
  if (!(await deps.registry.rolloutClaim(opts.env, holder, ROLLOUT_LOCK_SECONDS))) {
    return {
      ok: false,
      dry_run: false,
      error: "another schema rollout of this env is running (site_shard_rollout_locks); nothing was touched",
      shards: order.map(({ shard, canary }) => ({ shard: shard.name, canary, pending: [], applied: [], status: "skipped" as const })),
    };
  }
  try {
    return await runRollout(deps, opts, order, alert, holder);
  } finally {
    await deps.registry.rolloutRelease(opts.env, holder).catch((e: unknown) => log(`[shard-rollout] lock release failed (it lapses): ${errText(e)}`));
  }
}

const ADOPTABLE = [ROLLOUT_IN_PROGRESS, ROLLOUT_STOPPED];

async function freshRow(deps: RolloutDeps, shard: ShardRow): Promise<ShardRow & PauseFields> {
  return ((deps.registry.get ? await deps.registry.get(shard.id) : null) ?? shard) as ShardRow & PauseFields;
}

async function pauseUnlessHeld(deps: RolloutDeps, shard: ShardRow, reason: string): Promise<string | null> {
  if (deps.registry.pausePlacementUnlessHeld) {
    const r = await deps.registry.pausePlacementUnlessHeld(shard.id, reason, ADOPTABLE);
    return r.taken ? null : r.held_reason ?? "(no reason)";
  }
  const current = activePauseReason(await freshRow(deps, shard));
  if (current !== null && !rolloutOwnedPause(current)) return current;
  await deps.registry.pausePlacement(shard.id, reason, null);
  return null;
}

async function runRollout(
  deps: RolloutDeps,
  opts: RolloutOptions,
  order: Array<{ shard: ShardRow; canary: boolean }>,
  alert: (code: string, msg: string) => Promise<void>,
  holder: string,
): Promise<RolloutReport> {
  const log = deps.log ?? (() => undefined);
  const latest = latestVersion(deps.files);
  const report: RolloutReport = { ok: true, dry_run: !!opts.dryRun, shards: [] };
  const reason = `${ROLLOUT_PAUSE_REASON} (${holder})`;
  const quarantined = new Set<string>();
  let stopped = false;
  const stop = async (entry: ShardRolloutEntry, shard: ShardRow, why: string) => {
    report.ok = false;
    stopped = true;
    if (!opts.dryRun) {
      try {
        const held = entry.held_pause ?? (await pauseUnlessHeld(deps, shard, `${ROLLOUT_STOPPED}: ${why}`.slice(0, 300)));
        if (held) entry.held_pause = held;
        else entry.paused = true;
      } catch (e) {
        log(`[shard-rollout] could not keep ${shard.name} paused: ${errText(e)}`);
      }
    }
    const later = order.slice(report.shards.length);
    const stillQuarantined = order.filter(
      (o) => o.shard.id !== shard.id && quarantined.has(o.shard.id) && report.shards.find((e) => e.shard === o.shard.name)?.paused !== false,
    ).length;
    await alert(
      "sites.shards.rollout_failed",
      `shard schema rollout (${opts.env}) STOPPED at ${shard.name}: ${why}. ${entry.paused || entry.held_pause ? "Placement on it stays PAUSED until resumed. " : ""}${later.length} later shard(s) not touched${stillQuarantined ? `; ${stillQuarantined} other shard(s) stay paused: they lack schema files` : ""}.`,
    );
  };

  let quarantineFailure: { id: string; error: string } | null = null;
  if (opts.quarantine && !opts.dryRun) {
    for (const { shard } of order) {
      let lacks = true;
      try {
        lacks = pendingMigrations(deps.files, await readLedger(deps.sql, shard.project_ref as string)).length > 0;
      } catch (e) {
        log(`[shard-rollout] ${shard.name}: ledger unreadable, quarantined: ${errText(e)}`);
      }
      if (!lacks) continue;
      try {
        if (!(await pauseUnlessHeld(deps, shard, reason))) quarantined.add(shard.id);
      } catch (e) {
        quarantineFailure = { id: shard.id, error: errText(e) };
        break;
      }
    }
  }

  for (let i = 0; i < order.length; i++) {
    const { shard, canary } = order[i];
    const entry: ShardRolloutEntry = { shard: shard.name, canary, pending: [], applied: [], status: "skipped" };
    if (quarantined.has(shard.id)) {
      entry.quarantined = true;
      entry.paused = true;
    }
    report.shards.push(entry);
    if (stopped) continue;
    if (quarantineFailure) {
      if (shard.id === quarantineFailure.id) {
        entry.status = "failed";
        entry.error = `could not pause placement (quarantine): ${quarantineFailure.error}`;
        await stop(entry, shard, entry.error);
      }
      continue;
    }
    const ref = shard.project_ref as string;

    let pending: string[];
    try {
      pending = pendingMigrations(deps.files, await readLedger(deps.sql, ref)).map((f) => f.version);
    } catch (e) {
      entry.status = "failed";
      entry.error = `(ledger): ${errText(e)}`;
      await stop(entry, shard, entry.error);
      continue;
    }
    entry.pending = pending;
    if (opts.dryRun) {
      entry.status = "dry_run";
      continue;
    }

    const together = sameReleaseContracts(deps.files, new Set(pending));
    if (together.length) {
      entry.status = "failed";
      entry.error = `contract file in the same release as its expand file: ${together.join("; ")}. Roll out the expand file first, deploy the code that stops using the old shape, then roll out the contract file.`;
      await stop(entry, shard, entry.error);
      continue;
    }

    let stranded = false;
    if (!pending.length && !entry.quarantined) {
      const row = await freshRow(deps, shard).catch((e: unknown) => {
        log(`[shard-rollout] ${shard.name}: fresh pause read failed, using the listed row: ${errText(e)}`);
        return shard as ShardRow & PauseFields;
      });
      stranded = rolloutOwnedPause(activePauseReason(row));
    }

    if (pending.length || stranded || entry.quarantined) {
      try {
        if (!(await deps.registry.rolloutClaim(opts.env, holder, ROLLOUT_LOCK_SECONDS))) throw new Error("lost the env rollout lock");
        const held = await pauseUnlessHeld(deps, shard, reason);
        if (held) {
          entry.held_pause = held;
          entry.paused = false;
        } else {
          entry.paused = true;
        }
      } catch (e) {
        entry.status = "failed";
        entry.error = `could not pause placement: ${errText(e)}`;
        await stop(entry, shard, entry.error);
        continue;
      }
    }

    try {
      const r = await applyPendingMigrations(deps.sql, ref, deps.files, {
        checksums: { shard_id: shard.id, store: deps.registry },
      }).catch((e: unknown) => ({ pending, applied: [] as string[], failed: { version: "(ledger)", error: errText(e) } }));
      entry.applied = r.applied;
      if (r.failed) {
        entry.status = "failed";
        entry.error = `${r.failed.version}: ${r.failed.error}`;
        await stop(entry, shard, `${r.failed.version} failed: ${r.failed.error}`);
        continue;
      }
      entry.status = r.applied.length ? "applied" : "up_to_date";
      if (latest && shard.schema_version !== latest) await deps.registry.update(shard.id, { schema_version: latest });

      if (canary || stranded) {
        if (canary && deps.canarySoakMs && deps.canarySoakMs > 0 && r.applied.length) {
          await (deps.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms))))(deps.canarySoakMs);
        }
        const check = canary && deps.verifyCanary ? deps.verifyCanary : (s: ShardRow) => canaryHealthy(deps.sql, s, deps.files);
        const healthy = await check(shard).catch(() => false);
        if (!healthy) {
          entry.status = canary ? "canary_unhealthy" : "failed";
          if (!canary) entry.error = "unhealthy after an earlier rollout left it paused";
          await stop(entry, shard, canary ? "the canary is unhealthy after the rollout" : `${shard.name} is unhealthy after an earlier rollout left it paused`);
          continue;
        }
      }
      if (entry.paused) {
        const after = (await deps.registry.resumePlacement(shard.id, reason)) as ShardRow & { placement_paused_reason?: string | null };
        if (after && after.placement_paused_reason) throw new Error(`placement was re-paused by someone else (${String(after.placement_paused_reason).slice(0, 120)}); not resumed`);
        entry.paused = false;
      }
    } catch (e) {
      entry.status = "failed";
      entry.error = `${entry.error ? `${entry.error}; ` : ""}${errText(e)}`;
      await stop(entry, shard, `after its files ran: ${errText(e)}`);
    }
  }
  return report;
}
