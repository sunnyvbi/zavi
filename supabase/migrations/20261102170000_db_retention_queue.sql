begin;

create table if not exists public.db_run_retention (
  run_id uuid primary key references public.agent_runs(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  finished_at timestamptz,
  sent_to_ai boolean not null default false,
  raw_purged_at timestamptz,
  answers_purged_at timestamptz,
  version bigint not null default 0
);
comment on table public.db_run_retention is
  'Runs that read a customer database. Due-ness is computed at purge time from the tenant''s current settings; nothing here stores a due time. Server only.';
alter table public.db_run_retention enable row level security;
revoke all on public.db_run_retention from public, anon, authenticated;
create index if not exists db_run_retention_raw_open_idx
  on public.db_run_retention (tenant_id, finished_at nulls first) where raw_purged_at is null;
create index if not exists db_run_retention_answers_open_idx
  on public.db_run_retention (tenant_id, finished_at nulls first) where answers_purged_at is null;

create table if not exists public.db_run_retention_tenants (
  tenant_id uuid primary key references public.tenants(id) on delete cascade
);
alter table public.db_run_retention_tenants enable row level security;
revoke all on public.db_run_retention_tenants from public, anon, authenticated;

create index if not exists data_access_log_created_idx on public.data_access_log (created_at);
create index if not exists data_access_log_run_idx on public.data_access_log (run_id) where run_id is not null;

create or replace function public._db_raw_interval(p_setting text) returns interval
language sql immutable as $$
  select case p_setting when 'run' then interval '10 minutes' when '7' then interval '7 days' when '30' then interval '30 days' end
$$;
create or replace function public._db_chat_interval(p_setting text) returns interval
language sql immutable as $$
  select case p_setting when '30' then interval '30 days' when '90' then interval '90 days' end
$$;
revoke all on function public._db_raw_interval(text) from public, anon, authenticated;
revoke all on function public._db_chat_interval(text) from public, anon, authenticated;

create or replace function public._db_retention_settings(p_tenant_id uuid, out raw text, out chat text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  select s.raw_results_retention, s.chat_retention into raw, chat from public.tenant_db_settings s where s.tenant_id = p_tenant_id;
  if not found then
    raw := 'run';
    chat := '30';
  end if;
end $$;
revoke all on function public._db_retention_settings(uuid) from public, anon, authenticated;

create or replace function public._db_run_retention_on_log()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.run_id is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    insert into public.db_run_retention (run_id, tenant_id, finished_at, sent_to_ai)
    select new.run_id, r.tenant_id, r.finished_at, new.sent_to_ai from public.agent_runs r where r.id = new.run_id
    on conflict (run_id) do update
      set sent_to_ai = db_run_retention.sent_to_ai or excluded.sent_to_ai,
          raw_purged_at = null,
          answers_purged_at = null,
          version = db_run_retention.version + 1;
    insert into public.db_run_retention_tenants (tenant_id)
    select r.tenant_id from public.agent_runs r where r.id = new.run_id on conflict do nothing;
  elsif new.sent_to_ai and not old.sent_to_ai then
    update public.db_run_retention set sent_to_ai = true, answers_purged_at = null, version = version + 1 where run_id = new.run_id;
  end if;
  return new;
end $$;
revoke all on function public._db_run_retention_on_log() from public, anon, authenticated;
drop trigger if exists data_access_log_retention on public.data_access_log;
create trigger data_access_log_retention
  after insert or update of sent_to_ai on public.data_access_log
  for each row execute function public._db_run_retention_on_log();

create or replace function public._db_run_retention_on_finish()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.db_run_retention
     set finished_at = new.finished_at, raw_purged_at = null, answers_purged_at = null, version = version + 1
   where run_id = new.id and finished_at is distinct from new.finished_at;
  return new;
end $$;
revoke all on function public._db_run_retention_on_finish() from public, anon, authenticated;
drop trigger if exists agent_runs_db_retention_finish on public.agent_runs;
create trigger agent_runs_db_retention_finish
  after update of finished_at on public.agent_runs
  for each row when (new.finished_at is distinct from old.finished_at)
  execute function public._db_run_retention_on_finish();

create table if not exists public.db_run_retention_cursor (
  id boolean primary key default true check (id),
  after_run uuid,
  passes integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.db_run_retention_cursor enable row level security;
revoke all on public.db_run_retention_cursor from public, anon, authenticated;
insert into public.db_run_retention_cursor (id) values (true) on conflict do nothing;

create or replace function public.enqueue_db_run_retention_page(p_limit integer default 5000)
returns table (scanned integer, enqueued integer, wrapped boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 5000), 20000));
  v_after uuid;
  v_last uuid;
  v_scanned integer;
  v_enqueued integer;
  v_re constant text := '(^|__)operator_db(__|_)';
begin
  select c.after_run into v_after from public.db_run_retention_cursor c where c.id for update;
  select count(*)::integer, max(x.id::text)::uuid into v_scanned, v_last
    from (select r.id from public.agent_runs r
           where v_after is null or r.id > v_after
           order by r.id limit v_limit) x;
  if v_scanned = 0 then
    update public.db_run_retention_cursor set after_run = null, passes = passes + 1, updated_at = now() where id;
    return query select 0, 0, true;
    return;
  end if;

  with found as (
    insert into public.db_run_retention (run_id, tenant_id, finished_at, sent_to_ai)
    select p.id, p.tenant_id, p.finished_at, true
      from public.agent_runs p
     where (v_after is null or p.id > v_after) and p.id <= v_last
       and not exists (select 1 from public.db_run_retention q where q.run_id = p.id)
       and ((p.tool_calls is not null and jsonb_typeof(p.tool_calls) = 'array'
             and exists (select 1 from jsonb_array_elements(p.tool_calls) tc where tc->>'name' ~ v_re))
            or exists (select 1 from public.data_access_log l where l.run_id = p.id))
    on conflict (run_id) do nothing
    returning tenant_id
  ), tenants as (
    insert into public.db_run_retention_tenants (tenant_id) select distinct tenant_id from found on conflict do nothing
    returning 1
  )
  select count(*)::integer into v_enqueued from found;

  if v_scanned < v_limit then
    update public.db_run_retention_cursor set after_run = null, passes = passes + 1, updated_at = now() where id;
    return query select v_scanned, v_enqueued, true;
  else
    update public.db_run_retention_cursor set after_run = v_last, updated_at = now() where id;
    return query select v_scanned, v_enqueued, false;
  end if;
end $$;
revoke all on function public.enqueue_db_run_retention_page(integer) from public, anon, authenticated;
grant execute on function public.enqueue_db_run_retention_page(integer) to service_role;

create or replace function public.purge_db_raw_results(p_batch_limit integer default 500)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_batch_limit, 500), 5000));
  v_re constant text := '(^|__)operator_db(__|_)';
  v_done uuid[];
  v_versions bigint[];
begin
  select coalesce(array_agg(d.run_id), '{}'), coalesce(array_agg(d.version), '{}') into v_done, v_versions from (
    select q.run_id, q.version
      from public.db_run_retention_tenants t
      cross join lateral public._db_retention_settings(t.tenant_id) st
      cross join lateral (
        select q.run_id, q.version from public.db_run_retention q
          join public.agent_runs r on r.id = q.run_id
         where q.tenant_id = t.tenant_id and q.raw_purged_at is null
           and (q.finished_at is null or q.finished_at < now() - public._db_raw_interval(st.raw))
           and r.finished_at is not null and r.finished_at < now() - public._db_raw_interval(st.raw)
           and r.status in ('success', 'parse_failed', 'error', 'failed', 'cancelled', 'dispatch_error')
         order by q.finished_at nulls first
         limit v_limit
         for update of q skip locked
      ) q
     where public._db_raw_interval(st.raw) is not null
     limit v_limit
  ) d;

  update public.agent_runs r
     set tool_calls = (select jsonb_agg(case when tc->>'name' ~ v_re
                                             then tc || jsonb_build_object('output_preview', '', 'output_removed', 'privacy_setting')
                                             else tc end)
                         from jsonb_array_elements(r.tool_calls) tc)
   where r.id = any(v_done)
     and r.tool_calls is not null and jsonb_typeof(r.tool_calls) = 'array'
     and exists (select 1 from jsonb_array_elements(r.tool_calls) tc
                  where tc->>'name' ~ v_re and coalesce(tc->>'output_preview', '') <> '');
  delete from public.agent_run_checkpoints k where k.run_id = any(v_done);
  update public.db_run_retention q set raw_purged_at = now()
    from unnest(v_done, v_versions) as c(run_id, version)
   where q.run_id = c.run_id and q.version = c.version;
  return coalesce(array_length(v_done, 1), 0);
end $$;
revoke all on function public.purge_db_raw_results(integer) from public, anon, authenticated;
grant execute on function public.purge_db_raw_results(integer) to service_role;

create or replace function public.purge_db_chat_answers(p_batch_limit integer default 500)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_batch_limit, 500), 5000));
  v_done uuid[];
  v_versions bigint[];
begin
  select coalesce(array_agg(d.run_id), '{}'), coalesce(array_agg(d.version), '{}') into v_done, v_versions from (
    select q.run_id, q.version
      from public.db_run_retention_tenants t
      cross join lateral public._db_retention_settings(t.tenant_id) st
      cross join lateral (
        select q.run_id, q.version from public.db_run_retention q
          join public.agent_runs r on r.id = q.run_id
         where q.tenant_id = t.tenant_id and q.answers_purged_at is null
           and (q.finished_at is null or q.finished_at < now() - public._db_chat_interval(st.chat))
           and r.finished_at is not null and r.finished_at < now() - public._db_chat_interval(st.chat)
           and r.status in ('success', 'parse_failed', 'error', 'failed', 'cancelled', 'dispatch_error')
           and (exists (select 1 from public.data_access_log l where l.run_id = q.run_id and l.sent_to_ai)
                or not exists (select 1 from public.data_access_log l where l.run_id = q.run_id))
         order by q.finished_at nulls first
         limit v_limit
         for update of q skip locked
      ) q
     where public._db_chat_interval(st.chat) is not null
     limit v_limit
  ) d;

  delete from public.agent_thread_messages m
   where m.agent_run_id = any(v_done) and m.sender_role = 'assistant';
  delete from public.thread_event e
   where e.agent_run_id = any(v_done) and e.kind = 'chat_assistant';
  update public.agent_runs r
     set output_text = '', parsed = null, raw_response_text = null, assistant_turns = null
   where r.id = any(v_done);
  update public.db_run_retention q set answers_purged_at = now()
    from unnest(v_done, v_versions) as c(run_id, version)
   where q.run_id = c.run_id and q.version = c.version;
  return coalesce(array_length(v_done, 1), 0);
end $$;
revoke all on function public.purge_db_chat_answers(integer) from public, anon, authenticated;
grant execute on function public.purge_db_chat_answers(integer) to service_role;

create or replace function public.purge_data_access_log(p_batch_limit integer default 5000)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n integer;
begin
  with doomed as (
    select id from public.data_access_log where created_at < now() - interval '365 days'
     order by created_at limit greatest(1, least(coalesce(p_batch_limit, 5000), 20000))
  )
  delete from public.data_access_log l using doomed where l.id = doomed.id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.purge_data_access_log(integer) from public, anon, authenticated;
grant execute on function public.purge_data_access_log(integer) to service_role;

create or replace function public.db_retention_backlog()
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'raw_results', coalesce((
      select extract(epoch from now() - min(r.finished_at + public._db_raw_interval(st.raw)))::bigint
        from public.db_run_retention_tenants t
        cross join lateral public._db_retention_settings(t.tenant_id) st
        join public.db_run_retention q on q.tenant_id = t.tenant_id
        join public.agent_runs r on r.id = q.run_id
       where q.raw_purged_at is null and public._db_raw_interval(st.raw) is not null
         and r.status in ('success', 'parse_failed', 'error', 'failed', 'cancelled', 'dispatch_error')
         and r.finished_at < now() - public._db_raw_interval(st.raw)), 0),
    'chat_answers', coalesce((
      select extract(epoch from now() - min(r.finished_at + public._db_chat_interval(st.chat)))::bigint
        from public.db_run_retention_tenants t
        cross join lateral public._db_retention_settings(t.tenant_id) st
        join public.db_run_retention q on q.tenant_id = t.tenant_id
        join public.agent_runs r on r.id = q.run_id
       where q.answers_purged_at is null and public._db_chat_interval(st.chat) is not null
         and r.status in ('success', 'parse_failed', 'error', 'failed', 'cancelled', 'dispatch_error')
         and r.finished_at < now() - public._db_chat_interval(st.chat)
         and (exists (select 1 from public.data_access_log l where l.run_id = q.run_id and l.sent_to_ai)
              or not exists (select 1 from public.data_access_log l where l.run_id = q.run_id))), 0),
    'access_log', coalesce((select extract(epoch from now() - (min(created_at) + interval '365 days'))::bigint from public.data_access_log
                              where created_at < now() - interval '365 days'), 0)
  );
$$;
revoke all on function public.db_retention_backlog() from public, anon, authenticated;
grant execute on function public.db_retention_backlog() to service_role;

commit;
