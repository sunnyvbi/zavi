
import type { ShardEnv, ShardSql } from "./contract";
import type { ShardRegistry } from "./registry";
import type { GraduationStore } from "./graduation";
import { intLit } from "./sql";

export type GraduationThresholds = { records: number; bytes: number; writes_per_min: number; auto: boolean };

export type SiteLoad = { site_id: string; records: number; bytes: number; writes_per_min: number };

export async function sitesOverThreshold(sql: ShardSql, ref: string, t: GraduationThresholds, limit = 50): Promise<SiteLoad[]> {
  for (const v of [t.records, t.bytes, t.writes_per_min]) {
    if (!Number.isSafeInteger(v) || v <= 0) throw new Error("graduation thresholds must be positive integers");
  }
  const rows = (await sql.query(
    ref,
    `select u.site_id::text as site_id, u.records::bigint as records, u.bytes::bigint as bytes,
            case when u.window_start >= date_trunc('minute', now()) - interval '1 minute' then u.window_writes else 0 end as writes_per_min
       from zsite.usage u join zsite.sites s on s.site_id = u.site_id and s.status = 'active'
      where u.records >= ${intLit(t.records)} or u.bytes >= ${intLit(t.bytes)}
         or (u.window_start >= date_trunc('minute', now()) - interval '1 minute' and u.window_writes >= ${intLit(t.writes_per_min)})
      order by u.bytes desc limit ${intLit(limit)}`,
  )) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ site_id: String(r.site_id), records: Number(r.records), bytes: Number(r.bytes), writes_per_min: Number(r.writes_per_min) }));
}

export type TriggerDeps = {
  registry: Pick<ShardRegistry, "list">;
  sql: ShardSql;
  store: Pick<GraduationStore, "requestBySite">;
  thresholds: () => Promise<GraduationThresholds>;
  alert: (msg: string) => Promise<void>;
  log?: (l: string) => void;
};

export async function graduationTriggerSweep(deps: TriggerDeps, env: ShardEnv): Promise<{ over: number; requested: number; failed: number }> {
  const t = await deps.thresholds();
  let over = 0;
  let requested = 0;
  let failed = 0;
  for (const shard of await deps.registry.list(env)) {
    if (!shard.project_ref || shard.state === "retired" || shard.state === "provisioning") continue;
    if (shard.purpose === "validation") continue;
    let sites: SiteLoad[] = [];
    try {
      sites = await sitesOverThreshold(deps.sql, shard.project_ref, t);
    } catch (e) {
      failed++;
      deps.log?.(`[site-graduation] measure ${shard.name}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      continue;
    }
    for (const s of sites) {
      over++;
      const reason: "load" | "size" = s.writes_per_min >= t.writes_per_min && s.records < t.records && s.bytes < t.bytes ? "load" : "size";
      const line = `site ${s.site_id} on ${shard.name} is past its graduation threshold (${reason}: records=${s.records} bytes=${s.bytes} writes/min=${s.writes_per_min})`;
      if (!t.auto) {
        await deps.alert(`${line}; automatic move is off (site_graduation_auto)`).catch(() => undefined);
        continue;
      }
      try {
        if (await deps.store.requestBySite(s.site_id, reason)) requested++;
        await deps.alert(`${line}; graduation requested`).catch(() => undefined);
      } catch (e) {
        failed++;
        await deps.alert(`${line}; graduation request failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`).catch(() => undefined);
      }
    }
  }
  return { over, requested, failed };
}

export async function thresholdsFromSettings(): Promise<GraduationThresholds> {
  const { getNumberSetting, getBoolSetting } = await import("@/services/settings");
  const [records, bytes, writes_per_min, auto] = await Promise.all([
    getNumberSetting("site_graduation_records_threshold"),
    getNumberSetting("site_graduation_bytes_threshold"),
    getNumberSetting("site_graduation_writes_per_min_threshold"),
    getBoolSetting("site_graduation_auto"),
  ]);
  return { records: Math.floor(records), bytes: Math.floor(bytes), writes_per_min: Math.floor(writes_per_min), auto: auto === true };
}
