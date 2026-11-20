
drop table if exists lab.agent_runs;
create table lab.agent_runs (
  id           uuid primary key,
  tenant_id    uuid not null,
  channel_slug text
);
alter table lab.agent_runs enable row level security;
revoke all on lab.agent_runs from public, anon, authenticated;
grant all on lab.agent_runs to service_role;

create or replace function public.lab_card_parity()
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_problems text[] := '{}';
  v_t        text;
  v_diff     text;
  v_src      text;
  v_rel      text;
  v_want     text;
  v_have     text;
begin
  if to_regclass('lab.agent_runs') is null then
    v_problems := v_problems || 'lab.agent_runs is missing'::text;
  else
    select string_agg(x.column_name, ', ' order by x.column_name) into v_diff from (
      select p.column_name from information_schema.columns p
       where p.table_schema = 'public' and p.table_name = 'agent_runs'
         and p.column_name in ('id', 'tenant_id', 'channel_slug')
         and not exists (select 1 from information_schema.columns l
                          where l.table_schema = 'lab' and l.table_name = 'agent_runs'
                            and l.column_name = p.column_name and l.udt_name = p.udt_name)
    ) x;
    if v_diff is not null then
      v_problems := v_problems || format('agent_runs columns differ: %s', v_diff);
    end if;
  end if;

  foreach v_t in array array['channel_actions', 'channel_action_events', 'channel_metrics'] loop
    if to_regclass('lab.' || v_t) is null then
      v_problems := v_problems || format('lab.%s is missing', v_t);
      continue;
    end if;
    select string_agg(x.column_name, ', ' order by x.column_name) into v_diff from (
      (select column_name, udt_name, is_nullable, column_default, is_identity, identity_generation from information_schema.columns
        where table_schema = 'public' and table_name = v_t
       except
       select column_name, udt_name, is_nullable, column_default, is_identity, identity_generation from information_schema.columns
        where table_schema = 'lab' and table_name = v_t)
      union
      (select column_name, udt_name, is_nullable, column_default, is_identity, identity_generation from information_schema.columns
        where table_schema = 'lab' and table_name = v_t
       except
       select column_name, udt_name, is_nullable, column_default, is_identity, identity_generation from information_schema.columns
        where table_schema = 'public' and table_name = v_t)
    ) x;
    if v_diff is not null then
      v_problems := v_problems || format('%s columns differ: %s', v_t, v_diff);
    end if;
    select string_agg(d, ' | ') into v_diff from (
      (select regexp_replace(indexdef, '^CREATE UNIQUE INDEX \S+ ON \S+ ', '') d from pg_indexes
        where schemaname = 'public' and tablename = v_t and indexdef like 'CREATE UNIQUE%'
       except
       select regexp_replace(indexdef, '^CREATE UNIQUE INDEX \S+ ON \S+ ', '') from pg_indexes
        where schemaname = 'lab' and tablename = v_t and indexdef like 'CREATE UNIQUE%')
      union
      (select regexp_replace(indexdef, '^CREATE UNIQUE INDEX \S+ ON \S+ ', '') from pg_indexes
        where schemaname = 'lab' and tablename = v_t and indexdef like 'CREATE UNIQUE%'
       except
       select regexp_replace(indexdef, '^CREATE UNIQUE INDEX \S+ ON \S+ ', '') from pg_indexes
        where schemaname = 'public' and tablename = v_t and indexdef like 'CREATE UNIQUE%')
    ) y;
    if v_diff is not null then
      v_problems := v_problems || format('%s unique indexes differ: %s', v_t, v_diff);
    end if;
    select string_agg(d, ' | ') into v_diff from (
      (select pg_get_constraintdef(c.oid) d from pg_constraint c
        where c.conrelid = format('public.%I', v_t)::regclass and c.contype = 'c'
       except
       select pg_get_constraintdef(c.oid) from pg_constraint c
        where c.conrelid = format('lab.%I', v_t)::regclass and c.contype = 'c')
      union
      (select pg_get_constraintdef(c.oid) from pg_constraint c
        where c.conrelid = format('lab.%I', v_t)::regclass and c.contype = 'c'
       except
       select pg_get_constraintdef(c.oid) from pg_constraint c
        where c.conrelid = format('public.%I', v_t)::regclass and c.contype = 'c')
    ) z;
    if v_diff is not null then
      v_problems := v_problems || format('%s check constraints differ: %s', v_t, v_diff);
    end if;
  end loop;

  select regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '/\*.*?\*/', '', 'g') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_channel_run_actions';
  if v_src is null then
    v_problems := v_problems || 'public.record_channel_run_actions is missing'::text;
  else
    if v_src ~* '\mpublic\.' then
      v_problems := v_problems || 'record_channel_run_actions names a public.-qualified object'::text;
    end if;
    for v_rel in
      select distinct lower(m[2]) from regexp_matches(v_src, '\m(from|into|update|join)\s+([a-z_][a-z0-9_]*)', 'gi') m
       where lower(m[2]) in (select table_name from information_schema.tables where table_schema = 'public')
         and lower(m[2]) not in ('agent_runs', 'channel_actions', 'channel_action_events', 'channel_metrics')
    loop
      v_problems := v_problems || format('record_channel_run_actions now touches %s, which has no lab copy', v_rel);
    end loop;
  end if;

  if to_regprocedure('lab.record_channel_run_actions(uuid,uuid,jsonb,jsonb,jsonb)') is null then
    v_problems := v_problems || 'lab.record_channel_run_actions is missing'::text;
  else
    begin
      v_want := public.lab_card_fn_def();
      v_have := pg_get_functiondef('lab.record_channel_run_actions(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
      if v_want is distinct from v_have then
        v_problems := v_problems || 'lab.record_channel_run_actions differs from the live save function'::text;
      end if;
    exception when others then
      v_problems := v_problems || format('cannot derive the lab save function: %s', sqlerrm);
    end;
  end if;

  return jsonb_build_object('ok', cardinality(v_problems) = 0, 'problems', to_jsonb(v_problems));
end $$;

create or replace function public.lab_card_seed(
  p_tenant_id     uuid,
  p_channel       text,
  p_run_id        uuid,
  p_source_run_id uuid
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_cards   int;
  v_metrics int;
  v_run     int;
begin
  if p_channel is null or p_channel !~ '^[a-z0-9_]{1,40}$' then
    raise exception 'lab_card_seed: bad channel';
  end if;
  truncate lab.channel_action_events, lab.channel_actions, lab.channel_metrics, lab.agent_runs;
  insert into lab.channel_actions
    select * from public.channel_actions where tenant_id = p_tenant_id and channel_slug = p_channel;
  get diagnostics v_cards = row_count;
  insert into lab.channel_metrics
    select * from public.channel_metrics where tenant_id = p_tenant_id and channel_slug = p_channel;
  get diagnostics v_metrics = row_count;
  insert into lab.agent_runs (id, tenant_id, channel_slug)
    select p_run_id, r.tenant_id, p_channel from public.agent_runs r
     where r.id = p_source_run_id and r.tenant_id = p_tenant_id;
  get diagnostics v_run = row_count;
  if v_run <> 1 then
    raise exception 'lab_card_seed: source run % not found for this tenant', p_source_run_id;
  end if;
  return jsonb_build_object('cards', v_cards, 'metrics', v_metrics);
end $$;

revoke all on function public.lab_card_parity() from public, anon, authenticated;
grant execute on function public.lab_card_parity() to service_role;
revoke all on function public.lab_card_seed(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.lab_card_seed(uuid, text, uuid, uuid) to service_role;
