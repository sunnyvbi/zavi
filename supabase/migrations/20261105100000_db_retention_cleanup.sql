begin;

create table if not exists public.retention_purge_cursor (
  purge text primary key,
  after_ts timestamptz,
  after_id bigint,
  after_tenant uuid,
  after_key text,
  passes integer not null default 0,
  updated_at timestamptz not null default now()
);
comment on table public.retention_purge_cursor is
  'Keyset position of a retention purge that walks a table in passes. Server only.';
alter table public.retention_purge_cursor enable row level security;
revoke all on public.retention_purge_cursor from public, anon, authenticated;
insert into public.retention_purge_cursor (purge)
values ('sdk_sessions'), ('code_symbols'), ('code_symbol_refs'), ('code_index_phase')
on conflict (purge) do nothing;

create or replace function public._retention_require_index(p_index text, p_table text, p_columns text[], p_predicate text default null)
returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1 from pg_class c
      join pg_index i on i.indexrelid = c.oid
      join pg_am am on am.oid = c.relam
     where c.relnamespace = 'public'::regnamespace and c.relname = p_index and c.relkind = 'i'
       and am.amname = 'btree' and i.indisvalid and i.indexprs is null
       and i.indrelid = to_regclass('public.' || p_table)
       and (select array_agg(a.attname::text order by k.ord)
              from unnest(i.indkey) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) = p_columns
       and coalesce(regexp_replace(pg_get_expr(i.indpred, i.indrelid), '\s+', '', 'g'), '')
           = coalesce(regexp_replace(p_predicate, '\s+', '', 'g'), '')
  ) then
    raise exception 'retention purge refused: index % on % is missing, not valid or not the expected definition', p_index, p_table
      using errcode = '55000';
  end if;
end $$;
revoke all on function public._retention_require_index(text, text, text[], text) from public, anon, authenticated;

create or replace function public.purge_stream_drafts(p_batch_limit integer default 5000)
returns integer
language plpgsql security definer set search_path = public, pg_temp
  set statement_timeout = '30s' set lock_timeout = '5s' as $$
declare v_n integer;
begin
  perform public._retention_require_index('agent_run_stream_drafts_updated_idx', 'agent_run_stream_drafts', array['updated_at']);
  with doomed as (
    select d.run_id from public.agent_run_stream_drafts d
     where d.updated_at < now() - interval '1 day'
     order by d.updated_at
     limit greatest(1, least(coalesce(p_batch_limit, 5000), 20000))
     for update skip locked
  )
  delete from public.agent_run_stream_drafts d using doomed where d.run_id = doomed.run_id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.purge_memory_search_traces(p_batch_limit integer default 5000)
returns integer
language plpgsql security definer set search_path = public, pg_temp
  set statement_timeout = '30s' set lock_timeout = '5s' as $$
declare v_n integer;
begin
  perform public._retention_require_index('memory_search_trace_created_idx', 'memory_search_trace', array['created_at']);
  with doomed as (
    select t.id from public.memory_search_trace t
     where t.created_at < now() - interval '30 days'
     order by t.created_at
     limit greatest(1, least(coalesce(p_batch_limit, 5000), 20000))
     for update skip locked
  )
  delete from public.memory_search_trace t using doomed where t.id = doomed.id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.purge_eval_candidates(p_batch_limit integer default 5000)
returns integer
language plpgsql security definer set search_path = public, pg_temp
  set statement_timeout = '30s' set lock_timeout = '5s' as $$
declare v_n integer;
begin
  perform public._retention_require_index('eval_candidates_created_idx', 'eval_candidates', array['created_at']);
  with doomed as (
    select c.id from public.eval_candidates c
     where c.created_at < now() - interval '90 days'
     order by c.created_at
     limit greatest(1, least(coalesce(p_batch_limit, 5000), 20000))
     for update skip locked
  )
  delete from public.eval_candidates c using doomed where c.id = doomed.id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.purge_praxis_logs(p_batch_limit integer default 5000)
returns integer
language plpgsql security definer set search_path = public, pg_temp
  set statement_timeout = '30s' set lock_timeout = '5s' as $$
declare v_n integer;
begin
  perform public._retention_require_index('praxis_logs_created_idx', 'praxis_logs', array['created_at']);
  with doomed as (
    select l.id from public.praxis_logs l
     where l.created_at < now() - interval '90 days'
     order by l.created_at
     limit greatest(1, least(coalesce(p_batch_limit, 5000), 20000))
     for update skip locked
  )
  delete from public.praxis_logs l using doomed where l.id = doomed.id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.purge_run_events(p_batch_limit integer default 5000)
returns integer
language plpgsql security definer set search_path = public, pg_temp
  set statement_timeout = '30s' set lock_timeout = '5s' as $$
declare v_n integer;
begin
  perform public._retention_require_index('agent_run_events_prunable_created_idx', 'agent_run_events', array['created_at'],
    $p$(stage <> 'tool_use_completed'::agent_run_event_stage)$p$);
  with doomed as (
    select e.id from public.agent_run_events e
     where e.stage <> 'tool_use_completed'
       and e.created_at < now() - interval '30 days'
     order by e.created_at
     limit greatest(1, least(coalesce(p_batch_limit, 5000), 20000))
     for update skip locked
  )
  delete from public.agent_run_events e using doomed where e.id = doomed.id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.purge_thread_event_steps(p_batch_limit integer default 5000)
returns integer
language plpgsql security definer set search_path = public, pg_temp
  set statement_timeout = '30s' set lock_timeout = '5s' as $$
declare v_n integer;
begin
  perform public._retention_require_index('thread_event_prunable_created_idx', 'thread_event', array['created_at'],
    $p$(kind = ANY (ARRAY['tool_call'::text, 'reasoning'::text]))$p$);
  with doomed as (
    select e.id from public.thread_event e
     where e.kind in ('tool_call', 'reasoning')
       and e.created_at < now() - interval '90 days'
     order by e.created_at
     limit greatest(1, least(coalesce(p_batch_limit, 5000), 20000))
     for update skip locked
  )
  delete from public.thread_event e using doomed where e.id = doomed.id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.expire_stale_code_indexes(p_limit integer default 50)
returns integer
language plpgsql security definer set search_path = public, pg_temp
  set statement_timeout = '30s' set lock_timeout = '5s' as $$
declare
  v_cutoff constant timestamptz := now() - interval '60 days';
  r record;
  v_n integer;
  v_total integer := 0;
begin
  perform public._retention_require_index('code_index_state_committed_idx', 'code_index_state', array['indexed_at'], $p$(current_build_id IS NOT NULL)$p$);
  for r in
    select s.tenant_id, s.repo_full_name from public.code_index_state s
     where s.current_build_id is not null and s.indexed_at < v_cutoff
     order by s.indexed_at
     limit greatest(1, least(coalesce(p_limit, 50), 50))
  loop
    if pg_try_advisory_xact_lock(hashtextextended(r.tenant_id::text || ':' || r.repo_full_name, 0)) then
      update public.code_index_state s set current_build_id = null
       where s.tenant_id = r.tenant_id and s.repo_full_name = r.repo_full_name
         and s.current_build_id is not null and s.indexed_at < v_cutoff;
      get diagnostics v_n = row_count;
      v_total := v_total + v_n;
    end if;
  end loop;
  return v_total;
end $$;

create or replace function public._purge_code_index_orphans_in(p_table text, p_limit integer, p_max_pairs integer)
returns table (deleted integer, more boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_cutoff constant timestamptz := now() - interval '1 day';
  v_tenant uuid;
  v_repo text;
  v_prev_tenant uuid;
  v_prev_repo text;
  v_current uuid;
  v_build uuid;
  v_n integer;
  v_deleted integer := 0;
  v_pairs integer := 0;
  v_max_builds constant integer := 50;
  v_builds integer;
  v_pair_deleted integer;
begin
  if p_table not in ('code_symbols', 'code_symbol_refs') then
    raise exception '_purge_code_index_orphans_in: bad table %', p_table using errcode = '22023';
  end if;
  select c.after_tenant, c.after_key into v_tenant, v_repo
    from public.retention_purge_cursor c where c.purge = p_table for update;
  v_prev_tenant := v_tenant;
  v_prev_repo := v_repo;
  loop
    if v_tenant is null then
      execute format('select tenant_id, repo_full_name from public.%I order by tenant_id, repo_full_name limit 1', p_table)
        into v_tenant, v_repo;
    else
      execute format('select tenant_id, repo_full_name from public.%I where (tenant_id, repo_full_name) > ($1, $2)
                       order by tenant_id, repo_full_name limit 1', p_table)
        into v_tenant, v_repo using v_tenant, v_repo;
    end if;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      update public.retention_purge_cursor
         set after_tenant = null, after_key = null, passes = passes + 1, updated_at = now()
       where purge = p_table;
      return query select v_deleted, false;
      return;
    end if;
    v_pairs := v_pairs + 1;
    if pg_try_advisory_xact_lock(hashtextextended(v_tenant::text || ':' || v_repo, 0)) then
      v_current := null;
      select s.current_build_id into v_current
        from public.code_index_state s where s.tenant_id = v_tenant and s.repo_full_name = v_repo;
      v_build := null;
      v_builds := 0;
      v_pair_deleted := 0;
      loop
        v_builds := v_builds + 1;
        if v_builds > v_max_builds then
          update public.retention_purge_cursor
             set after_tenant = case when v_pair_deleted > 0 then v_prev_tenant else v_tenant end,
                 after_key = case when v_pair_deleted > 0 then v_prev_repo else v_repo end,
                 updated_at = now()
           where purge = p_table;
          return query select v_deleted, true;
          return;
        end if;
        if v_build is null then
          execute format('select build_id from public.%I where tenant_id = $1 and repo_full_name = $2 and build_id is not null
                           order by build_id limit 1', p_table)
            into v_build using v_tenant, v_repo;
        else
          execute format('select build_id from public.%I where tenant_id = $1 and repo_full_name = $2 and build_id > $3
                           order by build_id limit 1', p_table)
            into v_build using v_tenant, v_repo, v_build;
        end if;
        get diagnostics v_n = row_count;
        exit when v_n = 0;
        if v_build is distinct from v_current then
          execute format('with d as (select id from public.%I where tenant_id = $1 and repo_full_name = $2 and build_id = $3
                                       and coalesce(indexed_at, ''-infinity'') < $4 limit $5)
                          delete from public.%I t using d where t.id = d.id', p_table, p_table)
            using v_tenant, v_repo, v_build, v_cutoff, p_limit - v_deleted;
          get diagnostics v_n = row_count;
          v_deleted := v_deleted + v_n;
          v_pair_deleted := v_pair_deleted + v_n;
          if v_deleted >= p_limit then
            update public.retention_purge_cursor
               set after_tenant = v_prev_tenant, after_key = v_prev_repo, updated_at = now()
             where purge = p_table;
            return query select v_deleted, true;
            return;
          end if;
        end if;
      end loop;
      execute format('with d as (select id from public.%I where tenant_id = $1 and repo_full_name = $2 and build_id is null
                                   and coalesce(indexed_at, ''-infinity'') < $3 limit $4)
                      delete from public.%I t using d where t.id = d.id', p_table, p_table)
        using v_tenant, v_repo, v_cutoff, p_limit - v_deleted;
      get diagnostics v_n = row_count;
      v_deleted := v_deleted + v_n;
      if v_deleted >= p_limit then
        update public.retention_purge_cursor
           set after_tenant = v_prev_tenant, after_key = v_prev_repo, updated_at = now()
         where purge = p_table;
        return query select v_deleted, true;
        return;
      end if;
    end if;
    if v_pairs >= p_max_pairs then
      update public.retention_purge_cursor
         set after_tenant = v_tenant, after_key = v_repo, updated_at = now()
       where purge = p_table;
      return query select v_deleted, true;
      return;
    end if;
    v_prev_tenant := v_tenant;
    v_prev_repo := v_repo;
  end loop;
end $$;

create or replace function public.purge_code_index_orphans(p_batch_limit integer default 1000, p_max_pairs integer default 50)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
  set statement_timeout = '30s' set lock_timeout = '5s' as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_batch_limit, 1000), 5000));
  v_pairs integer := greatest(1, least(coalesce(p_max_pairs, 50), 50));
  v_phase text;
  r record;
begin
  perform public._retention_require_index('code_symbols_build_idx', 'code_symbols', array['tenant_id', 'repo_full_name', 'build_id']);
  perform public._retention_require_index('code_symbol_refs_build_idx', 'code_symbol_refs', array['tenant_id', 'repo_full_name', 'build_id']);
  select coalesce(c.after_key, 'code_symbol_refs') into v_phase
    from public.retention_purge_cursor c where c.purge = 'code_index_phase' for update;
  if v_phase not in ('code_symbol_refs', 'code_symbols') then
    v_phase := 'code_symbol_refs';
  end if;
  select * into r from public._purge_code_index_orphans_in(v_phase, v_limit, v_pairs);
  if r.more then
    return jsonb_build_object('deleted', r.deleted, 'more', true, 'phase', v_phase);
  end if;
  update public.retention_purge_cursor
     set after_key = case v_phase when 'code_symbol_refs' then 'code_symbols' else 'code_symbol_refs' end, updated_at = now()
   where purge = 'code_index_phase';
  return jsonb_build_object('deleted', r.deleted, 'more', v_phase = 'code_symbol_refs', 'phase', v_phase);
end $$;

create or replace function public._sdk_session_lock_key(p_tenant uuid, p_thread uuid, p_session_key text)
returns bigint
language sql immutable set search_path = public, pg_temp as $$
  select hashtextextended(p_tenant::text || '|' || p_thread::text || '|' || split_part(p_session_key, '::', 1), 0)
$$;
revoke all on function public._sdk_session_lock_key(uuid, uuid, text) from public, anon, authenticated;

create table if not exists public.sdk_session_purged (
  tenant_id uuid not null,
  thread_id uuid not null,
  session_id text not null,
  purged_at timestamptz not null default now(),
  primary key (tenant_id, thread_id, session_id)
);
comment on table public.sdk_session_purged is
  'SDK sessions removed by the retention purge; a late append to one is refused. Server only.';
alter table public.sdk_session_purged enable row level security;
revoke all on public.sdk_session_purged from public, anon, authenticated;
create index if not exists sdk_session_purged_at_idx on public.sdk_session_purged (purged_at);

create or replace function public.sdk_session_append(
  p_tenant      uuid,
  p_thread      uuid,
  p_project_key text,
  p_session_key text,
  p_entries     jsonb
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pos      bigint;
  v_entry    jsonb;
  v_uuid     text;
begin
  if p_tenant is null or p_thread is null or p_session_key is null then
    raise exception 'sdk_session_append: tenant/thread/session_key required';
  end if;
  perform pg_advisory_xact_lock(public._sdk_session_lock_key(p_tenant, p_thread, p_session_key));
  if exists (select 1 from public.sdk_session_purged x
              where x.tenant_id = p_tenant and x.thread_id = p_thread
                and x.session_id = split_part(p_session_key, '::', 1)) then
    raise exception 'sdk_session_append: session was purged by retention' using errcode = 'ZSP01';
  end if;

  select coalesce(max(position), 0) into v_pos
    from public.sdk_session_entries
   where tenant_id = p_tenant and thread_id = p_thread and session_key = p_session_key;

  for v_entry in select * from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb))
  loop
    v_uuid := nullif(v_entry->>'uuid', '');
    if v_uuid is not null then
      insert into public.sdk_session_entries
        (tenant_id, thread_id, project_key, session_key, position, entry_uuid, entry)
      values (p_tenant, p_thread, p_project_key, p_session_key, v_pos + 1, v_uuid, v_entry)
      on conflict (tenant_id, thread_id, session_key, entry_uuid) where entry_uuid is not null
        do nothing;
      if found then v_pos := v_pos + 1; end if;
    else
      insert into public.sdk_session_entries
        (tenant_id, thread_id, project_key, session_key, position, entry_uuid, entry)
      values (p_tenant, p_thread, p_project_key, p_session_key, v_pos + 1, null, v_entry);
      v_pos := v_pos + 1;
    end if;
  end loop;
end;
$$;
revoke all on function public.sdk_session_append(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.sdk_session_append(uuid, uuid, text, text, jsonb) to service_role;

create or replace function public.purge_sdk_sessions(p_batch_limit integer default 1000)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
  set statement_timeout = '30s' set lock_timeout = '5s' as $$
declare
  v_budget integer := greatest(1, least(coalesce(p_batch_limit, 1000), 5000));
  v_oversize constant integer := 5000;
  v_max_sessions constant integer := 50;
  v_cutoff constant timestamptz := now() - interval '30 days';
  v_after_ts timestamptz;
  v_after_id bigint;
  v_scanned integer;
  v_upto bigint;
  v_last_ts timestamptz;
  v_last_id bigint;
  s record;
  v_size integer;
  v_claimed integer := 0;
  v_claimed_rows integer := 0;
  v_oversized integer := 0;
  v_deferred boolean := false;
  v_n integer;
  v_rows integer := 0;
  v_sessions integer := 0;
begin
  perform public._retention_require_index('sdk_session_entries_created_idx', 'sdk_session_entries', array['created_at', 'id']);
  select c.after_ts, c.after_id into v_after_ts, v_after_id
    from public.retention_purge_cursor c where c.purge = 'sdk_sessions' for update;

  delete from public.sdk_session_purged x
   where (x.tenant_id, x.thread_id, x.session_id) in (
     select y.tenant_id, y.thread_id, y.session_id from public.sdk_session_purged y
      where y.purged_at < now() - interval '30 days' order by y.purged_at limit 1000);

  create temp table if not exists _sdk_purge_window (
    rn bigint, created_at timestamptz, id bigint, tenant_id uuid, thread_id uuid, sid text
  ) on commit drop;
  truncate _sdk_purge_window;
  if v_after_ts is null then
    insert into _sdk_purge_window
    select row_number() over (order by w.created_at, w.id), w.created_at, w.id, w.tenant_id, w.thread_id,
           split_part(w.session_key, '::', 1)
      from (select e.created_at, e.id, e.tenant_id, e.thread_id, e.session_key from public.sdk_session_entries e
             where e.created_at < v_cutoff
             order by e.created_at, e.id limit v_budget) w;
  else
    insert into _sdk_purge_window
    select row_number() over (order by w.created_at, w.id), w.created_at, w.id, w.tenant_id, w.thread_id,
           split_part(w.session_key, '::', 1)
      from (select e.created_at, e.id, e.tenant_id, e.thread_id, e.session_key from public.sdk_session_entries e
             where e.created_at < v_cutoff and (e.created_at, e.id) > (v_after_ts, v_after_id)
             order by e.created_at, e.id limit v_budget) w;
  end if;
  select count(*)::integer into v_scanned from _sdk_purge_window;
  v_upto := v_scanned;

  for s in
    select w.tenant_id, w.thread_id, w.sid, min(w.rn) as first_rn from _sdk_purge_window w
     group by w.tenant_id, w.thread_id, w.sid
     order by 4
  loop
    select count(*)::integer into v_size from (
      select 1 from public.sdk_session_entries e
       where e.tenant_id = s.tenant_id and e.thread_id = s.thread_id
         and (e.session_key = s.sid or left(e.session_key, length(s.sid) + 2) = s.sid || '::')
       limit v_oversize + 1) x;
    if v_size > v_oversize then
      v_oversized := v_oversized + 1;
      continue;
    end if;
    if v_claimed >= v_max_sessions or v_claimed_rows + v_size > v_budget then
      v_upto := s.first_rn - 1;
      v_deferred := v_claimed = 0;
      exit;
    end if;
    v_claimed := v_claimed + 1;
    v_claimed_rows := v_claimed_rows + v_size;
    perform pg_advisory_xact_lock(public._sdk_session_lock_key(s.tenant_id, s.thread_id, s.sid));
    if not exists (
      select 1 from public.sdk_session_entries e
       where e.tenant_id = s.tenant_id and e.thread_id = s.thread_id
         and (e.session_key = s.sid or left(e.session_key, length(s.sid) + 2) = s.sid || '::')
         and e.created_at >= v_cutoff
    ) then
      delete from public.sdk_session_entries e
       where e.tenant_id = s.tenant_id and e.thread_id = s.thread_id
         and (e.session_key = s.sid or left(e.session_key, length(s.sid) + 2) = s.sid || '::');
      get diagnostics v_n = row_count;
      if v_n > 0 then
        v_rows := v_rows + v_n;
        v_sessions := v_sessions + 1;
        insert into public.sdk_session_purged (tenant_id, thread_id, session_id)
        values (s.tenant_id, s.thread_id, s.sid)
        on conflict (tenant_id, thread_id, session_id) do update set purged_at = now();
        update public.agent_threads t set sdk_session_id = null
         where t.id = s.thread_id and t.tenant_id = s.tenant_id and t.sdk_session_id = s.sid;
      end if;
    end if;
  end loop;

  if v_upto >= v_scanned and v_scanned < v_budget then
    update public.retention_purge_cursor
       set after_ts = null, after_id = null, passes = passes + 1, updated_at = now()
     where purge = 'sdk_sessions';
    return jsonb_build_object('deleted', v_rows, 'sessions', v_sessions, 'oversized', v_oversized, 'deferred', false, 'more', false);
  end if;
  if v_upto > 0 then
    select w.created_at, w.id into v_last_ts, v_last_id from _sdk_purge_window w where w.rn = v_upto;
    update public.retention_purge_cursor
       set after_ts = v_last_ts, after_id = v_last_id, updated_at = now()
     where purge = 'sdk_sessions';
  end if;
  return jsonb_build_object('deleted', v_rows, 'sessions', v_sessions, 'oversized', v_oversized,
                            'deferred', v_deferred and v_upto = 0, 'more', not (v_deferred and v_upto = 0));
end $$;

create or replace function public.purge_ship_pr_file_contents(p_batch_limit integer default 200)
returns integer
language plpgsql security definer set search_path = public, pg_temp
  set statement_timeout = '30s' set lock_timeout = '5s' as $$
declare v_n integer;
begin
  perform public._retention_require_index('decisions_ship_pr_files_open_idx', 'decisions', array['emitted_at'],
    $p$((decision_class = 'engineer.ship-pr'::text) AND (body ? 'files'::text) AND (NOT (body ? 'files_content_purged_at'::text)))$p$);
  with doomed as (
    select d.id from public.decisions d
     where d.decision_class = 'engineer.ship-pr'
       and d.body ? 'files' and not (d.body ? 'files_content_purged_at')
       and d.emitted_at < now() - interval '30 days'
       and d.status in ('acted', 'dispatch_failed', 'rejected', 'expired')
     order by d.emitted_at
     limit greatest(1, least(coalesce(p_batch_limit, 200), 2000))
     for update skip locked
  )
  update public.decisions d
     set body = jsonb_set(
                  d.body,
                  '{files}',
                  case when jsonb_typeof(d.body -> 'files') = 'array' then
                    coalesce((
                      select jsonb_agg(
                               case when jsonb_typeof(f.v) = 'object'
                                    then jsonb_strip_nulls(jsonb_build_object('path', f.v -> 'path', 'action', f.v -> 'action'))
                                         || jsonb_build_object('content_purged', true)
                                    else f.v end
                               order by f.ord)
                        from jsonb_array_elements(d.body -> 'files') with ordinality as f(v, ord)
                    ), '[]'::jsonb)
                  else d.body -> 'files' end
                ) || jsonb_build_object('files_content_purged_at', now())
    from doomed
   where d.id = doomed.id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.purge_stream_drafts(integer) from public, anon, authenticated;
revoke all on function public.purge_memory_search_traces(integer) from public, anon, authenticated;
revoke all on function public.purge_eval_candidates(integer) from public, anon, authenticated;
revoke all on function public.purge_praxis_logs(integer) from public, anon, authenticated;
revoke all on function public.purge_run_events(integer) from public, anon, authenticated;
revoke all on function public.purge_thread_event_steps(integer) from public, anon, authenticated;
revoke all on function public.expire_stale_code_indexes(integer) from public, anon, authenticated;
revoke all on function public._purge_code_index_orphans_in(text, integer, integer) from public, anon, authenticated;
revoke all on function public.purge_code_index_orphans(integer, integer) from public, anon, authenticated;
revoke all on function public.purge_sdk_sessions(integer) from public, anon, authenticated;
revoke all on function public.purge_ship_pr_file_contents(integer) from public, anon, authenticated;
grant execute on function public.purge_stream_drafts(integer) to service_role;
grant execute on function public.purge_memory_search_traces(integer) to service_role;
grant execute on function public.purge_eval_candidates(integer) to service_role;
grant execute on function public.purge_praxis_logs(integer) to service_role;
grant execute on function public.purge_run_events(integer) to service_role;
grant execute on function public.purge_thread_event_steps(integer) to service_role;
grant execute on function public.expire_stale_code_indexes(integer) to service_role;
grant execute on function public.purge_code_index_orphans(integer, integer) to service_role;
grant execute on function public.purge_sdk_sessions(integer) to service_role;
grant execute on function public.purge_ship_pr_file_contents(integer) to service_role;

commit;
