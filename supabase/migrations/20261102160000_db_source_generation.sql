begin;

create table if not exists public.tenant_db_generation (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  generation bigint not null default 0 check (generation >= 0),
  updated_at timestamptz not null default now()
);
comment on table public.tenant_db_generation is
  'Monotonic per-tenant database source/policy generation. Bumped transactionally by every transition; reads, results, discovery writes and connector results are fenced against it. Server only.';
alter table public.tenant_db_generation enable row level security;
revoke all on public.tenant_db_generation from public, anon, authenticated;

create or replace function public._bump_db_generation(p_tenant_id uuid)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare v bigint;
begin
  if p_tenant_id is null then
    return null;
  end if;
  update public.tenant_db_generation set generation = generation + 1, updated_at = now()
   where tenant_id = p_tenant_id
  returning generation into v;
  if found then
    return v;
  end if;
  insert into public.tenant_db_generation as g (tenant_id, generation)
  select p_tenant_id, 1 where exists (select 1 from public.tenants where id = p_tenant_id)
  on conflict (tenant_id) do update set generation = g.generation + 1, updated_at = now()
  returning generation into v;
  return v;
end $$;
revoke all on function public._bump_db_generation(uuid) from public, anon, authenticated;
grant execute on function public._bump_db_generation(uuid) to service_role;

create or replace function public._lock_db_generation(p_tenant_id uuid)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare v bigint;
begin
  select generation into v from public.tenant_db_generation where tenant_id = p_tenant_id for share;
  if found then
    return v;
  end if;
  insert into public.tenant_db_generation (tenant_id, generation)
  select p_tenant_id, 0 where exists (select 1 from public.tenants where id = p_tenant_id)
  on conflict (tenant_id) do nothing;
  select generation into v from public.tenant_db_generation where tenant_id = p_tenant_id for share;
  return coalesce(v, 0);
end $$;
revoke all on function public._lock_db_generation(uuid) from public, anon, authenticated;
grant execute on function public._lock_db_generation(uuid) to service_role;

create or replace function public._db_generation_on_config()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    perform public._bump_db_generation(old.tenant_id);
    return old;
  end if;
  if tg_op = 'INSERT'
     or (old.type, old.mode, old.connection_secret_key, old.disabled_tables, old.hidden_fields,
         old.unhidden_fields, old.auto_hide, old.policy_catalog_hash)
        is distinct from
        (new.type, new.mode, new.connection_secret_key, new.disabled_tables, new.hidden_fields,
         new.unhidden_fields, new.auto_hide, new.policy_catalog_hash) then
    perform public._bump_db_generation(new.tenant_id);
  end if;
  return new;
end $$;
revoke all on function public._db_generation_on_config() from public, anon, authenticated;
drop trigger if exists tenant_db_config_generation on public.tenant_db_config;
create trigger tenant_db_config_generation
  after insert or update or delete on public.tenant_db_config
  for each row execute function public._db_generation_on_config();

alter table public.db_connectors
  add column if not exists source_instance_id text
    check (source_instance_id is null or source_instance_id ~ '^[0-9a-f]{32}$');
comment on column public.db_connectors.source_instance_id is
  'The connector''s random id for its locally saved database, regenerated on every save/remove. A change (null included) is a source transition.';

create or replace function public._db_generation_on_connector()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    perform public._bump_db_generation(old.tenant_id);
    return old;
  end if;
  if tg_op = 'INSERT'
     or (old.revoked_at, old.dialect, old.rules_hash, old.source_instance_id)
        is distinct from (new.revoked_at, new.dialect, new.rules_hash, new.source_instance_id) then
    perform public._bump_db_generation(new.tenant_id);
  end if;
  return new;
end $$;
revoke all on function public._db_generation_on_connector() from public, anon, authenticated;
drop trigger if exists db_connectors_generation on public.db_connectors;
create trigger db_connectors_generation
  after insert or update or delete on public.db_connectors
  for each row execute function public._db_generation_on_connector();

create or replace function public._reset_db_policy_for_transition(p_tenant_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.tenant_db_catalog where tenant_id = p_tenant_id;
  update public.tenant_db_config
     set auto_hide = true, settings_confirmed_at = null, updated_at = now()
   where tenant_id = p_tenant_id;
  perform public._bump_db_generation(p_tenant_id);
end $$;
revoke all on function public._reset_db_policy_for_transition(uuid) from public, anon, authenticated;
grant execute on function public._reset_db_policy_for_transition(uuid) to service_role;

create or replace function public.reserve_data_access(
  p_tenant_id uuid,
  p_generation bigint,
  p_caller_kind text,
  p_agent_slug text,
  p_run_id uuid,
  p_tool_name text,
  p_feature text,
  p_user_id uuid,
  p_mode text,
  p_dialect text,
  p_operation text,
  p_query_text text,
  p_tables text[]
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_gen bigint;
begin
  if p_generation is not null then
    select generation into v_gen from public.tenant_db_generation where tenant_id = p_tenant_id;
    if coalesce(v_gen, 0) <> p_generation then
      raise exception 'database source changed' using errcode = 'ZD412';
    end if;
  end if;
  insert into public.data_access_log (
    tenant_id, caller_kind, agent_slug, run_id, tool_name, feature, user_id,
    mode, dialect, operation, query_text, tables, result
  ) values (
    p_tenant_id, p_caller_kind, p_agent_slug, p_run_id, p_tool_name, p_feature, p_user_id,
    p_mode, p_dialect, p_operation, left(coalesce(nullif(p_query_text, ''), '(empty)'), 20000),
    coalesce(p_tables[1:50], '{}'), 'pending'
  )
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.reserve_data_access(uuid, bigint, text, text, uuid, text, text, uuid, text, text, text, text, text[]) from public, anon, authenticated;
grant execute on function public.reserve_data_access(uuid, bigint, text, text, uuid, text, text, uuid, text, text, text, text, text[]) to service_role;

create or replace function public.finalize_data_access(
  p_tenant_id uuid,
  p_id uuid,
  p_generation bigint,
  p_result text,
  p_row_count integer,
  p_sent_to_ai boolean,
  p_refused_by text,
  p_reason text,
  p_totals_only boolean,
  p_ms integer
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_gen bigint;
begin
  if p_result is null or p_result not in ('allowed', 'refused', 'failed') then
    raise exception 'bad result' using errcode = '22023';
  end if;
  if p_result = 'allowed' and p_generation is not null then
    v_gen := public._lock_db_generation(p_tenant_id);
    if v_gen <> p_generation then
      update public.data_access_log
         set finished_at = now(), result = 'failed', row_count = 0, sent_to_ai = false,
             refused_by = null, reason = 'source changed: the connection or its settings changed during this read, so the result was discarded',
             totals_only = coalesce(p_totals_only, false), ms = greatest(0, coalesce(p_ms, 0))
       where id = p_id and tenant_id = p_tenant_id;
      return 'source_changed';
    end if;
  end if;
  update public.data_access_log
     set finished_at = now(),
         result = p_result,
         row_count = greatest(0, coalesce(p_row_count, 0)),
         sent_to_ai = coalesce(p_sent_to_ai, false) and p_result = 'allowed',
         refused_by = p_refused_by,
         reason = left(p_reason, 500),
         totals_only = coalesce(p_totals_only, false),
         ms = greatest(0, coalesce(p_ms, 0))
   where id = p_id and tenant_id = p_tenant_id;
  if not found then
    return 'not_found';
  end if;
  return 'ok';
end $$;
revoke all on function public.finalize_data_access(uuid, uuid, bigint, text, integer, boolean, text, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.finalize_data_access(uuid, uuid, bigint, text, integer, boolean, text, text, boolean, integer) to service_role;

create or replace function public.set_tenant_db_catalog(
  p_tenant_id uuid,
  p_dialect text,
  p_catalog jsonb,
  p_hints jsonb,
  p_discovery_error text,
  p_coverage jsonb,
  p_generation bigint
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_generation is null then
    raise exception 'generation is required' using errcode = '22023';
  end if;
  if public._lock_db_generation(p_tenant_id) <> p_generation then
    return false;
  end if;
  perform public.set_tenant_db_catalog(p_tenant_id, p_dialect, p_catalog, p_hints, p_discovery_error, p_coverage);
  return true;
end $$;
revoke all on function public.set_tenant_db_catalog(uuid, text, jsonb, jsonb, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.set_tenant_db_catalog(uuid, text, jsonb, jsonb, text, jsonb, bigint) to service_role;

create or replace function public.stamp_tenant_db_discovery_error(p_tenant_id uuid, p_error text, p_generation bigint)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_generation is null then
    raise exception 'generation is required' using errcode = '22023';
  end if;
  if public._lock_db_generation(p_tenant_id) <> p_generation then
    return false;
  end if;
  update public.tenant_db_catalog set discovery_error = left(p_error, 500), updated_at = now()
   where tenant_id = p_tenant_id;
  return true;
end $$;
revoke all on function public.stamp_tenant_db_discovery_error(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.stamp_tenant_db_discovery_error(uuid, text, bigint) to service_role;

alter table public.db_connector_requests add column if not exists generation bigint;
comment on column public.db_connector_requests.generation is
  'The tenant generation the read was resolved under; the connector echoes it and a mismatched result is never stored.';

create or replace function public.enqueue_db_connector_request(p_tenant_id uuid, p_op jsonb, p_ttl_seconds integer, p_generation bigint)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_conn uuid;
  v_reserved uuid;
  v_id uuid;
  v_gen bigint;
  v_ttl integer := greatest(5, least(coalesce(p_ttl_seconds, 60), 180));
begin
  if p_op is null or jsonb_typeof(p_op) <> 'object' or octet_length(p_op::text) > 200000 then
    raise exception 'bad op' using errcode = '22023';
  end if;
  if p_generation is null then
    raise exception 'generation is required' using errcode = '22023';
  end if;
  select generation into v_gen from public.tenant_db_generation where tenant_id = p_tenant_id;
  if coalesce(v_gen, 0) <> p_generation then
    raise exception 'database source changed' using errcode = 'ZD412';
  end if;
  select c.id into v_conn from public.db_connectors c
   where c.tenant_id = p_tenant_id and c.revoked_at is null;
  if v_conn is null then
    return null;
  end if;
  update public.db_connectors set outstanding = outstanding + 1
   where id = v_conn and outstanding < 200
  returning id into v_reserved;
  if v_reserved is null then
    raise exception 'connector queue full' using errcode = 'ZD429';
  end if;
  insert into public.db_connector_requests (tenant_id, connector_id, op, expires_at, generation)
  values (p_tenant_id, v_conn, p_op, now() + make_interval(secs => v_ttl), p_generation)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.enqueue_db_connector_request(uuid, jsonb, integer, bigint) from public, anon, authenticated;
grant execute on function public.enqueue_db_connector_request(uuid, jsonb, integer, bigint) to service_role;

drop function if exists public.claim_db_connector_request(uuid, uuid);
create function public.claim_db_connector_request(p_tenant_id uuid, p_connector_id uuid)
returns table (id uuid, execution_token uuid, op jsonb, generation bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from public.db_connectors c
                  where c.id = p_connector_id and c.tenant_id = p_tenant_id and c.revoked_at is null) then
    return;
  end if;
  update public.db_connectors c set last_seen_at = now(),
         offline_notified_at = case when c.last_seen_at < now() - interval '30 seconds' then null else c.offline_notified_at end
   where c.id = p_connector_id and c.tenant_id = p_tenant_id
     and (c.last_seen_at is null or c.last_seen_at < now() - interval '10 seconds');

  update public.db_connector_requests r
     set status = case when r.deliveries >= 3 then 'failed' else 'queued' end,
         reason = case when r.deliveries >= 3 then 'The connector did not finish this read after 3 tries.' else r.reason end,
         finished_at = case when r.deliveries >= 3 then now() else null end,
         execution_token = case when r.deliveries >= 3 then r.execution_token else null end,
         lease_until = null
   where r.connector_id = p_connector_id and r.tenant_id = p_tenant_id
     and r.status = 'delivered' and r.lease_until <= now() and r.expires_at > now();

  select r.id into v_id from public.db_connector_requests r
   where r.connector_id = p_connector_id and r.tenant_id = p_tenant_id
     and r.status = 'queued' and r.expires_at > now()
   order by r.created_at
   limit 1
   for update skip locked;
  if v_id is null then
    return;
  end if;
  return query
  update public.db_connector_requests r
     set status = 'delivered', execution_token = gen_random_uuid(),
         lease_until = now() + interval '30 seconds', deliveries = r.deliveries + 1
   where r.id = v_id
  returning r.id, r.execution_token, r.op, r.generation;
end $$;
revoke all on function public.claim_db_connector_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_db_connector_request(uuid, uuid) to service_role;

create or replace function public.complete_db_connector_request(
  p_tenant_id uuid, p_connector_id uuid, p_request_id uuid, p_execution_token uuid,
  p_status text, p_result jsonb, p_reason text, p_generation bigint, p_source_instance_id text
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status text;
  v_token uuid;
  v_gen bigint;
  v_source text;
begin
  if p_status is null or p_status not in ('done', 'refused', 'failed') then
    raise exception 'bad status' using errcode = '22023';
  end if;
  if p_result is not null and octet_length(p_result::text) > 950000 then
    raise exception 'result too large' using errcode = '22023';
  end if;
  select r.status, r.execution_token, r.generation into v_status, v_token, v_gen from public.db_connector_requests r
   where r.id = p_request_id and r.tenant_id = p_tenant_id and r.connector_id = p_connector_id
   for update;
  if not found or v_token is distinct from p_execution_token then
    return 'stale';
  end if;
  if v_status in ('done', 'refused', 'failed') then
    return 'duplicate';
  end if;
  select c.source_instance_id into v_source from public.db_connectors c
   where c.id = p_connector_id and c.tenant_id = p_tenant_id and c.revoked_at is null;
  if not found then
    return 'stale';
  end if;
  if p_status = 'done' and (p_generation is distinct from v_gen or p_source_instance_id is distinct from v_source) then
    update public.db_connector_requests
       set status = 'failed', result = null, reason = 'source_changed', lease_until = null, finished_at = now()
     where id = p_request_id and status = 'delivered';
    return 'source_changed';
  end if;
  update public.db_connector_requests
     set status = p_status, result = p_result, reason = left(p_reason, 500),
         lease_until = null, finished_at = now()
   where id = p_request_id and status = 'delivered' and expires_at > now();
  if not found then
    return 'stale';
  end if;
  return 'accepted';
end $$;
revoke all on function public.complete_db_connector_request(uuid, uuid, uuid, uuid, text, jsonb, text, bigint, text) from public, anon, authenticated;
grant execute on function public.complete_db_connector_request(uuid, uuid, uuid, uuid, text, jsonb, text, bigint, text) to service_role;

create or replace function public.touch_db_connector(
  p_tenant_id uuid, p_connector_id uuid, p_machine text, p_version text, p_rules jsonb, p_rules_hash text, p_source_instance_id text
) returns table (is_active boolean, was_offline boolean, offline_seconds integer, rules_changed boolean, discovery_generation bigint, source_changed boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_seen timestamptz;
  v_hash text;
  v_source text;
  v_was_offline boolean;
  v_changed boolean;
  v_source_changed boolean;
  v_connector_mode boolean;
  v_gen bigint;
begin
  if (p_rules is null) <> (p_rules_hash is null) then
    raise exception 'rules and rules_hash go together' using errcode = '22023';
  end if;
  if p_source_instance_id is not null and p_source_instance_id !~ '^[0-9a-f]{32}$' then
    raise exception 'bad source instance' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('operator_db_connection:' || p_tenant_id::text));
  select c.last_seen_at, c.rules_hash, c.source_instance_id into v_seen, v_hash, v_source from public.db_connectors c
   where c.id = p_connector_id and c.tenant_id = p_tenant_id and c.revoked_at is null
   for update;
  if not found then
    return query select false, false, 0, false, null::bigint, false;
    return;
  end if;
  v_was_offline := v_seen is null or v_seen < now() - interval '30 seconds';
  v_changed := p_rules_hash is not null and p_rules_hash is distinct from v_hash;
  v_source_changed := p_source_instance_id is distinct from v_source;
  update public.db_connectors
     set last_seen_at = now(),
         offline_notified_at = case when v_was_offline then null else offline_notified_at end,
         machine_name = coalesce(left(p_machine, 120), machine_name),
         version = coalesce(left(p_version, 40), version),
         rules = coalesce(p_rules, rules),
         rules_hash = coalesce(p_rules_hash, rules_hash),
         source_instance_id = p_source_instance_id
   where id = p_connector_id;
  if v_was_offline then
    update public.db_connector_offline_notices set closed_at = now()
     where connector_id = p_connector_id and sent_at is null and closed_at is null;
  end if;
  if v_changed or v_source_changed then
    update public.db_connector_requests
       set status = 'failed', result = null, reason = 'source_changed', lease_until = null, finished_at = now()
     where tenant_id = p_tenant_id and status in ('queued', 'delivered');
  end if;
  v_connector_mode := exists (select 1 from public.tenant_db_config c where c.tenant_id = p_tenant_id and c.mode = 'connector');
  if v_source_changed and v_connector_mode then
    perform public._reset_db_policy_for_transition(p_tenant_id);
  end if;
  if v_connector_mode
     and ((v_source_changed and p_source_instance_id is not null)
          or v_changed
          or (v_was_offline and not exists (
                select 1 from public.tenant_db_catalog k
                 where k.tenant_id = p_tenant_id and k.discovery_error is null
                   and jsonb_array_length(coalesce(k.catalog->'tables', '[]'::jsonb)) > 0))) then
    v_gen := public._request_db_connector_discovery(p_tenant_id);
  end if;
  return query select true, v_was_offline, coalesce(extract(epoch from (now() - v_seen))::integer, 0), v_changed, v_gen, v_source_changed;
end $$;
revoke all on function public.touch_db_connector(uuid, uuid, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.touch_db_connector(uuid, uuid, text, text, jsonb, text, text) to service_role;

commit;
