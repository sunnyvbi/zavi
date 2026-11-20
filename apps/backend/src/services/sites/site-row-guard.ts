
export const ROWS_CHANGED_MARKER = "zavi existing rows changed";

const TAG_RE = /^[0-9a-f]{8,32}$/;

function tableName(tag: string): string {
  if (!TAG_RE.test(tag)) throw new Error("site row guard: invalid tag");
  return `zavi_rows_${tag}`;
}

export function rowGuardSnapshotSql(tag: string): string {
  const t = tableName(tag);
  return `create temp table ${t} on commit drop as
  select c.oid as relid, c.relfilenode as filenode, n.nspname || '.' || c.relname as name
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'r'
     and n.nspname not in ('pg_catalog', 'information_schema')
     and n.nspname !~ '^pg_(toast|temp)';`;
}

export function rowGuardAssertSql(tag: string): string {
  const t = tableName(tag);
  return `set constraints all immediate;
do $zavi_rows$
declare v text;
begin
  if pg_catalog.current_setting('track_counts') <> 'on' then
    raise exception '${ROWS_CHANGED_MARKER}: cannot verify (table statistics are off)';
  end if;
  select string_agg(
           p.name || ' (' ||
           case when c.oid is null then 'dropped'
                when c.relfilenode is distinct from p.filenode then 'rewritten or truncated'
                else coalesce(s.n_tup_upd, 0) || ' updated, ' || coalesce(s.n_tup_del, 0) || ' deleted' end || ')',
           ', ' order by p.name)
    into v
    from pg_temp.${t} p
    left join pg_catalog.pg_class c on c.oid = p.relid
    left join pg_catalog.pg_stat_xact_all_tables s on s.relid = p.relid
   where c.oid is null
      or c.relfilenode is distinct from p.filenode
      or coalesce(s.n_tup_upd, 0) + coalesce(s.n_tup_del, 0) > 0;
  if v is not null then
    raise exception '${ROWS_CHANGED_MARKER}: %', v;
  end if;
end $zavi_rows$;`;
}
