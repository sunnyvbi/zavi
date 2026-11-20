
const SMOKE_LOG_FN = "zavi._smoke_log_fn";
const SMOKE_FN_MARK = "zavi smoke log v1 (platform-owned)";
const LOCK = "pg_catalog.pg_advisory_xact_lock(7243012019)";

const OURS = `g.tgfoid = coalesce(pg_catalog.to_regproc('${SMOKE_LOG_FN}')::oid, 0)
    and pg_catalog.obj_description(g.tgfoid, 'pg_proc') = '${SMOKE_FN_MARK}'
    and ((g.tgname = 'zz_zavi_smoke_9f3c2e_i' and g.tgtype = 5) or (g.tgname = 'zz_zavi_smoke_9f3c2e_d' and g.tgtype = 11)
         or (g.tgname = 'zz_zavi_smoke_9f3c2e_t' and g.tgtype = 32))`;

export const SMOKE_HOOKS_LEFT_SQL = `select
  (select count(*)::int from pg_catalog.pg_trigger g where ${OURS}) as triggers,
  ((pg_catalog.to_regproc('${SMOKE_LOG_FN}') is not null
      and pg_catalog.obj_description(pg_catalog.to_regproc('${SMOKE_LOG_FN}')::oid, 'pg_proc') = '${SMOKE_FN_MARK}')::int
   + (pg_catalog.to_regclass('zavi._smoke_run') is not null)::int
   + (pg_catalog.to_regclass('zavi._smoke_log') is not null)::int
   + (pg_catalog.to_regclass('zavi._smoke_pre') is not null)::int) as objects;`;

export const SMOKE_HOOKS_REMOVE_SQL = `set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = '';
do $zavi_smoke_cleanup$
declare r record;
begin
  perform ${LOCK};
  for r in select n.nspname::text as sch, c.relname::text as tbl, g.tgname::text as nm
             from pg_catalog.pg_trigger g join pg_catalog.pg_class c on c.oid = g.tgrelid
             join pg_catalog.pg_namespace n on n.oid = c.relnamespace
            where ${OURS} and g.tgparentid = 0
            order by c.relispartition, c.oid loop
    execute pg_catalog.format('drop trigger if exists %I on %I.%I', r.nm, r.sch, r.tbl);
  end loop;
  -- Anything else still calling the function (a trigger that is not exactly
  -- ours) keeps the function AND the tables it writes: nothing it needs goes;
  -- the re-read reports the site for a manual look.
  -- A same-named function without our mark is not ours either: leave it all.
  if pg_catalog.to_regproc('${SMOKE_LOG_FN}') is not null then
    if exists (select 1 from pg_catalog.pg_trigger g where g.tgfoid = pg_catalog.to_regproc('${SMOKE_LOG_FN}')::oid)
       or pg_catalog.obj_description(pg_catalog.to_regproc('${SMOKE_LOG_FN}')::oid, 'pg_proc') is distinct from '${SMOKE_FN_MARK}' then
      return;
    end if;
    drop function zavi._smoke_log_fn();
  end if;
  drop table if exists zavi._smoke_log;
  drop table if exists zavi._smoke_run;
  drop table if exists zavi._smoke_pre;
end $zavi_smoke_cleanup$;`;

export type SmokeHooksLeft = { triggers: number; objects: number };

export function parseHooksLeft(rows: unknown[]): SmokeHooksLeft {
  const r = (rows[0] ?? {}) as { triggers?: unknown; objects?: unknown };
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return { triggers: n(r.triggers), objects: n(r.objects) };
}
