
import type { CollectionDef, ShardSql } from "./contract";
import type { CollectionPlan } from "./collections-plan";
import { dollarQuote, intLit, jsonLit, nameLit, publishFenceSql, textLit, uuidLit } from "./sql";

export const RECORD_DELETE_BATCH = 5_000;
export const EXPORT_PAGE = 1_000;

export async function ensureShardSite(sql: ShardSql, ref: string, site_id: string): Promise<void> {
  const rows = (await sql.query(
    ref,
    `insert into zsite.sites (site_id) values (${uuidLit(site_id)}) on conflict (site_id) do nothing;
     select status from zsite.sites where site_id = ${uuidLit(site_id)};`,
  )) as Array<{ status?: string }>;
  const status = rows[rows.length - 1]?.status;
  if (status !== "active") throw new Error(`shard site is ${status ?? "missing"}`);
}

export async function readCollections(sql: ShardSql, ref: string, site_id: string): Promise<CollectionDef[]> {
  const rows = (await sql.query(
    ref,
    `select name, kind, rules, schema, fields, indexes, archived_at is not null as archived from zsite.collections
      where site_id = ${uuidLit(site_id)} order by name collate "C"`,
  )) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    name: String(r.name),
    kind: r.kind === "files" ? "files" : "records",
    rules: (r.rules ?? {}) as Record<string, string[]>,
    schema: (r.schema ?? {}) as Record<string, unknown>,
    fields: (r.fields ?? {}) as Record<string, unknown>,
    indexes: (r.indexes ?? {}) as Record<string, unknown>,
    archived: r.archived === true,
  }));
}

export function collectionsSnapshot(cols: CollectionDef[]): CollectionDef[] {
  return [...cols].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function applyPlanSql(site_id: string, plan: CollectionPlan, current: CollectionDef[], generation?: number): string {
  const s = uuidLit(site_id);
  const snapshot = collectionsSnapshot(current).map((c) => ({
    name: c.name, kind: c.kind, rules: c.rules, schema: c.schema, fields: c.fields, indexes: c.indexes, archived: c.archived === true,
  }));
  const parts: string[] = [
    "begin;",
    "set local statement_timeout = '300s';",
    ...(generation !== undefined ? [publishFenceSql(site_id, generation)] : []),
    `select 1 from zsite.sites where site_id = ${s} for update;`,
    `do ${dollarQuote(`
     begin
       if not exists (select 1 from zsite.sites where site_id = ${s} and status = 'active') then
         raise exception 'shard_site_not_active';
       end if;
       if (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'kind', kind, 'rules', rules, 'schema', schema,
                  'fields', fields, 'indexes', indexes, 'archived', archived_at is not null) order by name collate "C"), '[]'::jsonb)
             from zsite.collections where site_id = ${s}) is distinct from ${jsonLit(snapshot)} then
         raise exception 'collections_changed';
       end if;
     end`)};`,
  ];
  for (const c of plan.add) {
    parts.push(
      `insert into zsite.collections (site_id, name, kind, rules, schema, fields, indexes)
       values (${s}, ${nameLit(c.name)}, ${textLit(c.kind)}, ${jsonLit(c.rules)}, ${jsonLit(c.schema)},
               ${jsonLit(c.fields)}, ${jsonLit(c.indexes)});`,
    );
  }
  for (const c of plan.change) {
    parts.push(
      `update zsite.collections set rules = ${jsonLit(c.rules)}, schema = ${jsonLit(c.schema)},
              fields = ${jsonLit(c.fields)}, indexes = ${jsonLit(c.indexes)}, archived_at = null, updated_at = now()
        where site_id = ${s} and name = ${nameLit(c.name)};`,
    );
  }
  if (plan.archive.length) {
    parts.push(
      `update zsite.collections set archived_at = now(), updated_at = now()
        where site_id = ${s} and archived_at is null and name in (${plan.archive.map(nameLit).join(", ")});`,
    );
  }
  parts.push("commit;");
  return parts.join("\n");
}

export async function applyCollectionPlan(
  sql: ShardSql,
  ref: string,
  site_id: string,
  plan: CollectionPlan,
  current: CollectionDef[],
  generation?: number,
): Promise<void> {
  await sql.query(ref, applyPlanSql(site_id, plan, current, generation));
}

export const REINDEX_BATCH = 2_000;

export async function reindexCollection(sql: ShardSql, ref: string, site_id: string, collection: string, maxBatches = 50): Promise<boolean> {
  let after: string | null = null;
  let gen: number | null = null;
  for (let i = 0; i < maxBatches; i++) {
    const rows = (await sql.query(
      ref,
      `select zsite.reindex_batch(${uuidLit(site_id)}, ${nameLit(collection)}, ${after ? uuidLit(after) : "null"}, ${gen === null ? "null" : intLit(gen)}, ${intLit(REINDEX_BATCH)}) as r`,
    )) as Array<{ r?: { next_after?: string | null; gen?: number | null; done?: boolean; restart?: boolean } }>;
    const r = rows[0]?.r ?? {};
    if (r.done === true) return true;
    if (r.restart === true) {
      after = null;
      gen = null;
      continue;
    }
    after = typeof r.next_after === "string" ? r.next_after : null;
    gen = typeof r.gen === "number" ? r.gen : null;
  }
  return false;
}

export async function pendingReindexes(sql: ShardSql, ref: string, site_id?: string, limit = 100): Promise<Array<{ site_id: string; name: string }>> {
  return (await sql.query(
    ref,
    `select site_id::text as site_id, name from zsite.collections where reindex_pending
        ${site_id ? `and site_id = ${uuidLit(site_id)}` : ""} order by updated_at limit ${intLit(limit)}`,
  )) as Array<{ site_id: string; name: string }>;
}

export async function isActiveAdmin(sql: ShardSql, ref: string, site_id: string, user_id: string): Promise<boolean> {
  const rows = (await sql.query(
    ref,
    `select 1 as ok from zsite.members where site_id = ${uuidLit(site_id)} and user_id = ${uuidLit(user_id)}
        and role = 'admin' and status = 'active'`,
  )) as unknown[];
  return rows.length > 0;
}

export async function markShardSiteDeleting(sql: ShardSql, ref: string, site_id: string): Promise<boolean> {
  const rows = (await sql.query(
    ref,
    `update zsite.sites set status = 'deleting' where site_id = ${uuidLit(site_id)} returning site_id`,
  )) as unknown[];
  return rows.length > 0;
}

export async function deleteRecordBatch(sql: ShardSql, ref: string, site_id: string, limit = RECORD_DELETE_BATCH): Promise<number> {
  const rows = (await sql.query(
    ref,
    `with victim as (
       select collection, id from zsite.records where site_id = ${uuidLit(site_id)} limit ${intLit(limit)}
     )
     delete from zsite.records r using victim v
      where r.site_id = ${uuidLit(site_id)} and r.collection = v.collection and r.id = v.id
     returning 1`,
  )) as unknown[];
  return rows.length;
}

export async function siteAuthUserIds(sql: ShardSql, ref: string, site_id: string): Promise<string[]> {
  const rows = (await sql.query(
    ref,
    `select auth_user_id from zsite.identities where site_id = ${uuidLit(site_id)}`,
  )) as Array<{ auth_user_id?: string }>;
  return rows.map((r) => String(r.auth_user_id ?? "")).filter(Boolean);
}

export async function deleteShardSiteRows(sql: ShardSql, ref: string, site_id: string): Promise<void> {
  const s = uuidLit(site_id);
  await sql.query(
    ref,
    `begin;
     do $zavi$ begin
       if exists (select 1 from zsite.records where site_id = ${s}) then raise exception 'records_remain'; end if;
     end $zavi$;
     delete from zsite.members where site_id = ${s};
     delete from zsite.identities where site_id = ${s};
     delete from zsite.sites where site_id = ${s};
     commit;`,
  );
}

export async function shardSiteLeftovers(sql: ShardSql, ref: string, site_id: string): Promise<Record<string, number>> {
  const s = uuidLit(site_id);
  const rows = (await sql.query(
    ref,
    `select (select count(*) from zsite.sites where site_id = ${s})::int as sites,
            (select count(*) from zsite.collections where site_id = ${s})::int as collections,
            (select count(*) from zsite.records where site_id = ${s})::int as records,
            (select count(*) from zsite.identities where site_id = ${s})::int as identities,
            (select count(*) from zsite.members where site_id = ${s})::int as members,
            (select count(*) from zsite.quotas where site_id = ${s})::int as quotas,
            (select count(*) from zsite.usage where site_id = ${s})::int as usage`,
  )) as Array<Record<string, number>>;
  const r = rows[0] ?? {};
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}

export async function exportRecordPage(
  sql: ShardSql,
  ref: string,
  site_id: string,
  after: { created_at: string; collection: string; id: string } | null,
  limit = EXPORT_PAGE,
): Promise<Array<{ collection: string; id: string; owner_id: string | null; data: unknown; created_at: string; updated_at: string }>> {
  const s = uuidLit(site_id);
  const cursor = after
    ? `and (created_at, collection, id) > (${textLit(after.created_at)}::timestamptz, ${nameLit(after.collection)}, ${uuidLit(after.id)})`
    : "";
  return (await sql.query(
    ref,
    `select collection, id, owner_id, data,
            to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
            to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
       from zsite.records where site_id = ${s} ${cursor}
      order by created_at, collection, id limit ${intLit(limit)}`,
  )) as Array<{ collection: string; id: string; owner_id: string | null; data: unknown; created_at: string; updated_at: string }>;
}

export async function exportMembers(sql: ShardSql, ref: string, site_id: string): Promise<unknown[]> {
  return sql.query(
    ref,
    `select i.email_norm as email, m.role, m.status, m.created_at
       from zsite.members m join zsite.identities i on i.site_id = m.site_id and i.auth_user_id = m.user_id
      where m.site_id = ${uuidLit(site_id)} order by m.created_at`,
  );
}

export async function suspendShardSite(sql: ShardSql, ref: string, site_id: string): Promise<string> {
  const rows = (await sql.query(
    ref,
    `update zsite.sites set status = 'suspended' where site_id = ${uuidLit(site_id)} and status in ('active', 'suspended')
     returning status`,
  )) as unknown[];
  if (!rows.length) throw new Error("suspendShardSite: the shard site is not active");
  const t = (await sql.query(ref, `select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`)) as Array<{ t?: string }>;
  if (!t[0]?.t) throw new Error("suspendShardSite: no clock reading");
  return t[0].t;
}

export async function shardSiteDrained(sql: ShardSql, ref: string, frozen_at: string): Promise<boolean> {
  const rows = (await sql.query(
    ref,
    `select count(*)::int as n from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'
        and xact_start is not null and xact_start < ${textLit(frozen_at)}::timestamptz`,
  )) as Array<{ n?: number }>;
  return Number(rows[0]?.n ?? 1) === 0;
}

export async function unsuspendShardSite(sql: ShardSql, ref: string, site_id: string): Promise<void> {
  await sql.query(ref, `update zsite.sites set status = 'active' where site_id = ${uuidLit(site_id)} and status = 'suspended'`);
}
