
set statement_timeout = 0;
set lock_timeout = '5s';

do $$
declare
  r           record;
  v_fixed     int := 0;
  v_skipped   int := 0;
  v_remaining int;
begin
  for r in
    select p.oid::regprocedure as sig,
           substring(c.elem from '^search_path=(.*)$') as sp
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    left join lateral (
      select e as elem from unnest(p.proconfig) e where e like 'search_path=%' limit 1
    ) c on true
    where n.nspname = 'public'
      and p.prosecdef
      and not exists (
        select 1 from pg_depend d
        where d.objid = p.oid
          and d.classid = 'pg_proc'::regclass
          and d.deptype = 'e'
      )
  loop
    if r.sp is not null
       and 'pg_temp' = any(string_to_array(replace(r.sp, ' ', ''), ',')) then
      continue;
    end if;
    if r.sp is null or r.sp !~ '^[a-z_][a-z0-9_, ]*$' then
      v_skipped := v_skipped + 1;
      raise notice 'search_path sweep: SKIP % (unhandled search_path: %)', r.sig, coalesce(r.sp, '(none)');
      continue;
    end if;
    begin
      execute format('alter function %s set search_path = %s, pg_temp', r.sig, r.sp);
      v_fixed := v_fixed + 1;
    exception when others then
      v_skipped := v_skipped + 1;
      raise notice 'search_path sweep: SKIP % (% : %)', r.sig, sqlstate, sqlerrm;
    end;
  end loop;

  select count(*) into v_remaining
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and not exists (
      select 1 from pg_depend d
      where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
    )
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, '{}')) e
      where e like 'search_path=%'
        and 'pg_temp' = any(string_to_array(replace(substring(e from '^search_path=(.*)$'), ' ', ''), ','))
    );

  raise notice 'search_path sweep complete: % pinned, % skipped, % still unpinned', v_fixed, v_skipped, v_remaining;
  if v_remaining > 0 then
    raise warning 'search_path sweep: % public security-definer function(s) remain UNPINNED — review the SKIP notices above', v_remaining;
  end if;
end $$;
