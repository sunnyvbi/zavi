begin;

create table if not exists public.tenant_db_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  raw_results_retention text check (raw_results_retention is null or raw_results_retention in ('run', '7', '30')),
  chat_retention text check (chat_retention is null or chat_retention in ('forever', '90', '30')),
  managed_db_opt_out_at timestamptz,
  updated_at timestamptz not null default now()
);
comment on table public.tenant_db_settings is
  'Your database privacy settings and the managed-database opt-out. Survives a disconnect so retention keeps applying. Backend only (tenantClient); written by the settings RPCs.';
alter table public.tenant_db_settings enable row level security;
revoke all on public.tenant_db_settings from public, anon, authenticated;

insert into public.tenant_db_settings (tenant_id)
select c.tenant_id from public.tenant_db_config c
on conflict (tenant_id) do nothing;

create table if not exists public.db_access_requests (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_requested_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
comment on table public.db_access_requests is
  'Last time a member asked owners/admins to connect the database (Request access). Backend only; one email per member per 24 hours.';
alter table public.db_access_requests enable row level security;
revoke all on public.db_access_requests from public, anon, authenticated;

create or replace function public.claim_db_access_request(p_tenant_id uuid, p_user_id uuid)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_claimed boolean;
begin
  if p_tenant_id is null or p_user_id is null then
    raise exception 'tenant and user are required' using errcode = '22023';
  end if;
  insert into public.db_access_requests as r (tenant_id, user_id, last_requested_at)
  values (p_tenant_id, p_user_id, now())
  on conflict (tenant_id, user_id) do update
     set last_requested_at = excluded.last_requested_at
   where r.last_requested_at < now() - interval '24 hours'
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end $$;
revoke all on function public.claim_db_access_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_db_access_request(uuid, uuid) to service_role;

create or replace function set_operator_db_connection(
  p_tenant_id uuid,
  p_type text,
  p_connection_string text,
  p_schema_map jsonb
) returns void
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_old uuid;
  v_new uuid;
  v_secret_key text := 'operator_db.connection_string';
  v_new_connection boolean;
begin
  perform _assert_tenant_admin(p_tenant_id);
  perform pg_advisory_xact_lock(hashtext('operator_db_connection:' || p_tenant_id::text));

  select vault_secret_id into v_old from secrets
   where tenant_id = p_tenant_id and key = v_secret_key;
  if v_old is not null then
    delete from vault.secrets where id = v_old;
    delete from secrets where tenant_id = p_tenant_id and key = v_secret_key;
  end if;
  v_new := vault.create_secret(p_connection_string);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, v_secret_key, v_new);

  v_new_connection := not exists (select 1 from tenant_db_config where tenant_id = p_tenant_id);
  insert into tenant_db_config (tenant_id, type, connection_secret_key, schema_map, updated_at, mode, auto_hide)
  values (p_tenant_id, p_type::operator_db_type, v_secret_key, p_schema_map, now(), 'direct', true)
  on conflict (tenant_id)
  do update set
    type = excluded.type,
    connection_secret_key = excluded.connection_secret_key,
    schema_map = excluded.schema_map,
    mode = 'direct',
    updated_at = now();

  if v_new_connection then
    insert into tenant_db_settings (tenant_id, raw_results_retention, chat_retention, managed_db_opt_out_at, updated_at)
    values (p_tenant_id, 'run', 'forever', null, now())
    on conflict (tenant_id) do update set
      raw_results_retention = coalesce(tenant_db_settings.raw_results_retention, 'run'),
      chat_retention = coalesce(tenant_db_settings.chat_retention, 'forever'),
      managed_db_opt_out_at = null,
      updated_at = now();
  else
    update tenant_db_settings set managed_db_opt_out_at = null, updated_at = now()
     where tenant_id = p_tenant_id and managed_db_opt_out_at is not null;
  end if;

  perform public._reset_db_policy_for_transition(p_tenant_id);

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at, managed_by)
  values (
    p_tenant_id,
    'operator_db',
    p_type,
    'Your database',
    array['read', 'update_status']::text[],
    now(),
    null
  )
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id, team_name = 'Your database',
                connected_at = excluded.connected_at, managed_by = null;
end $$;
revoke all on function set_operator_db_connection(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function set_operator_db_connection(uuid, text, text, jsonb) to authenticated, service_role;

create or replace function set_managed_operator_db_connection(
  p_tenant_id uuid,
  p_connection_string text
) returns boolean
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_old uuid;
  v_new uuid;
  v_secret_key text := 'operator_db.connection_string';
  v_new_connection boolean;
begin
  if p_tenant_id is null or p_connection_string is null or length(p_connection_string) < 8 then
    raise exception 'tenant and connection string are required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from tenant_resources
     where tenant_id = p_tenant_id and resource_kind = 'db' and mode = 'provisioned'
  ) then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtext('operator_db_connection:' || p_tenant_id::text));

  if exists (
    select 1 from tenant_db_settings
     where tenant_id = p_tenant_id and managed_db_opt_out_at is not null
  ) then
    return false;
  end if;

  if exists (
    select 1 from connector_metadata
     where tenant_id = p_tenant_id and slug = 'operator_db'
       and managed_by is distinct from 'zavi'
  ) then
    return false;
  end if;

  select vault_secret_id into v_old from secrets
   where tenant_id = p_tenant_id and key = v_secret_key;
  if v_old is not null then
    delete from vault.secrets where id = v_old;
    delete from secrets where tenant_id = p_tenant_id and key = v_secret_key;
  end if;
  v_new := vault.create_secret(p_connection_string);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, v_secret_key, v_new);

  v_new_connection := not exists (select 1 from tenant_db_config where tenant_id = p_tenant_id);
  insert into tenant_db_config (tenant_id, type, connection_secret_key, schema_map, updated_at, mode, auto_hide)
  values (p_tenant_id, 'postgres'::operator_db_type, v_secret_key, '{}'::jsonb, now(), 'direct', true)
  on conflict (tenant_id)
  do update set
    type = excluded.type,
    connection_secret_key = excluded.connection_secret_key,
    schema_map = excluded.schema_map,
    updated_at = now();
  if v_new_connection then
    insert into tenant_db_settings (tenant_id, raw_results_retention, chat_retention, updated_at)
    values (p_tenant_id, 'run', 'forever', now())
    on conflict (tenant_id) do update set
      raw_results_retention = coalesce(tenant_db_settings.raw_results_retention, 'run'),
      chat_retention = coalesce(tenant_db_settings.chat_retention, 'forever'),
      updated_at = now();
  end if;

  perform public._reset_db_policy_for_transition(p_tenant_id);

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at, managed_by)
  values (p_tenant_id, 'operator_db', 'postgres', 'Your database', array['read']::text[], now(), 'zavi')
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id, team_name = 'Your database',
                connected_at = excluded.connected_at, managed_by = 'zavi'
  where connector_metadata.managed_by = 'zavi';

  return true;
end $$;
revoke all on function set_managed_operator_db_connection(uuid, text) from public, anon, authenticated;
grant execute on function set_managed_operator_db_connection(uuid, text) to service_role;

create or replace function public.set_db_visibility(
  p_tenant_id uuid,
  p_catalog_hash text,
  p_disabled_tables text[],
  p_hidden_fields text[],
  p_unhidden_fields text[]
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_hash text;
begin
  perform _assert_tenant_admin(p_tenant_id);
  if coalesce(array_length(p_disabled_tables, 1), 0) > 2000
     or coalesce(array_length(p_hidden_fields, 1), 0) > 5000
     or coalesce(array_length(p_unhidden_fields, 1), 0) > 5000 then
    raise exception 'too many entries' using errcode = '22023';
  end if;
  select k.catalog_hash into v_hash from public.tenant_db_catalog k where k.tenant_id = p_tenant_id for share;
  if p_catalog_hash is null or v_hash is null or v_hash <> p_catalog_hash then
    raise exception 'catalog changed' using errcode = 'ZD409';
  end if;
  update public.tenant_db_config
     set disabled_tables = coalesce(p_disabled_tables, '{}'),
         hidden_fields = coalesce(p_hidden_fields, '{}'),
         unhidden_fields = coalesce(p_unhidden_fields, '{}'),
         auto_hide = true,
         settings_confirmed_at = now(),
         updated_at = now(),
         policy_catalog_hash = v_hash
   where tenant_id = p_tenant_id;
  if not found then
    raise exception 'not connected' using errcode = 'P0002';
  end if;
  insert into public.tenant_config_audit (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
  values (p_tenant_id, auth.uid(), 'set', 'operator_db.visibility', null, null,
          jsonb_build_object(
            'disabled', coalesce(array_length(p_disabled_tables, 1), 0),
            'hidden', coalesce(array_length(p_hidden_fields, 1), 0),
            'unhidden', coalesce(array_length(p_unhidden_fields, 1), 0)));
end $$;
revoke all on function public.set_db_visibility(uuid, text, text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.set_db_visibility(uuid, text, text[], text[], text[]) to authenticated, service_role;

create or replace function public.set_db_privacy(
  p_tenant_id uuid,
  p_raw_results_retention text,
  p_chat_retention text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform _assert_tenant_admin(p_tenant_id);
  if p_raw_results_retention is null or p_raw_results_retention not in ('run', '7', '30')
     or p_chat_retention is null or p_chat_retention not in ('forever', '90', '30') then
    raise exception 'invalid retention' using errcode = '22023';
  end if;
  if not exists (select 1 from public.tenant_db_config where tenant_id = p_tenant_id) then
    raise exception 'not connected' using errcode = 'P0002';
  end if;
  insert into public.tenant_db_settings (tenant_id, raw_results_retention, chat_retention, updated_at)
  values (p_tenant_id, p_raw_results_retention, p_chat_retention, now())
  on conflict (tenant_id) do update set
    raw_results_retention = excluded.raw_results_retention,
    chat_retention = excluded.chat_retention,
    updated_at = now();
  insert into public.tenant_config_audit (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
  values (p_tenant_id, auth.uid(), 'set', 'operator_db.privacy', null,
          p_raw_results_retention || '/' || p_chat_retention, '{}'::jsonb);
end $$;
revoke all on function public.set_db_privacy(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_db_privacy(uuid, text, text) to authenticated, service_role;

create or replace function public.disconnect_operator_db(p_tenant_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_key text;
  v_old uuid;
  v_dialect text;
  v_managed text;
begin
  perform _assert_tenant_admin(p_tenant_id);
  perform pg_advisory_xact_lock(hashtext('operator_db_connection:' || p_tenant_id::text));
  select c.type::text into v_dialect from public.tenant_db_config c where c.tenant_id = p_tenant_id;
  select m.managed_by into v_managed from public.connector_metadata m where m.tenant_id = p_tenant_id and m.slug = 'operator_db';
  for v_key in
    select key from public.secrets where tenant_id = p_tenant_id and left(key, 12) = 'operator_db.'
  loop
    select vault_secret_id into v_old from public.secrets where tenant_id = p_tenant_id and key = v_key;
    if v_old is not null then
      delete from vault.secrets where id = v_old;
    end if;
    delete from public.secrets where tenant_id = p_tenant_id and key = v_key;
  end loop;
  insert into public.tenant_db_settings (tenant_id, managed_db_opt_out_at, updated_at)
  values (p_tenant_id, case when v_managed = 'zavi' then now() end, now())
  on conflict (tenant_id) do update set
    managed_db_opt_out_at = coalesce(case when v_managed = 'zavi' then now() end, tenant_db_settings.managed_db_opt_out_at),
    updated_at = now();
  delete from public.connector_metadata where tenant_id = p_tenant_id and slug = 'operator_db';
  delete from public.tenant_db_config where tenant_id = p_tenant_id;
  delete from public.tenant_db_catalog where tenant_id = p_tenant_id;
  update public.tenant_mcp_servers set enabled = false where tenant_id = p_tenant_id and server_id = 'operator_db';
  insert into public.tenant_config_audit (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
  values (p_tenant_id, auth.uid(), 'clear', 'operator_db.connection', null, null,
          jsonb_build_object('source', 'disconnect_operator_db', 'managed_by', v_managed));
  return jsonb_build_object('dialect', v_dialect, 'managed_by', v_managed);
end $$;
revoke all on function public.disconnect_operator_db(uuid) from public, anon, authenticated;
grant execute on function public.disconnect_operator_db(uuid) to authenticated, service_role;

create or replace function public.tenant_admin_emails(p_tenant_id uuid)
returns setof text
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select lower(u.email)
    from public.tenant_users tu
    join auth.users u on u.id = tu.user_id
   where tu.tenant_id = p_tenant_id
     and tu.role in ('owner', 'admin')
     and u.email is not null;
$$;
revoke all on function public.tenant_admin_emails(uuid) from public, anon, authenticated;
grant execute on function public.tenant_admin_emails(uuid) to service_role;

create or replace function public.purge_db_raw_results(p_batch_limit integer default 500)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n integer;
  v_re constant text := '(^|__)operator_db(__|_)';
  v_limit integer := greatest(1, least(p_batch_limit, 2000));
begin
  with policy as (
    select s.tenant_id, s.raw_results_retention as raw from public.tenant_db_settings s
     where s.raw_results_retention in ('run', '7', '30')
    union all
    select l.tenant_id, 'run' from (select distinct tenant_id from public.data_access_log) l
     where not exists (select 1 from public.tenant_db_settings s where s.tenant_id = l.tenant_id)
  ),
  targets as (
    select r.id
      from public.agent_runs r
      join policy p on p.tenant_id = r.tenant_id
     where r.status in ('success', 'parse_failed', 'error', 'failed', 'cancelled', 'dispatch_error')
       and r.finished_at is not null
       and r.finished_at < now() - case p.raw
                                     when 'run' then interval '10 minutes'
                                     else (p.raw || ' days')::interval
                                   end
       and r.tool_calls is not null
       and jsonb_typeof(r.tool_calls) = 'array'
       and exists (select 1 from jsonb_array_elements(r.tool_calls) tc
                    where tc->>'name' ~ v_re and coalesce(tc->>'output_preview', '') <> '')
     limit v_limit
  )
  update public.agent_runs r
     set tool_calls = (select jsonb_agg(case when tc->>'name' ~ v_re
                                             then tc || jsonb_build_object('output_preview', '', 'output_removed', 'privacy_setting')
                                             else tc end)
                         from jsonb_array_elements(r.tool_calls) tc)
    from targets
   where r.id = targets.id;
  get diagnostics v_n = row_count;

  with policy as (
    select s.tenant_id, s.raw_results_retention as raw from public.tenant_db_settings s
     where s.raw_results_retention in ('run', '7', '30')
    union all
    select l.tenant_id, 'run' from (select distinct tenant_id from public.data_access_log) l
     where not exists (select 1 from public.tenant_db_settings s where s.tenant_id = l.tenant_id)
  )
  delete from public.agent_run_checkpoints k
   using public.agent_runs r, policy p
   where k.run_id = r.id
     and k.tenant_id = r.tenant_id
     and p.tenant_id = r.tenant_id
     and r.status in ('success', 'parse_failed', 'error', 'failed', 'cancelled', 'dispatch_error')
     and r.finished_at is not null
     and r.finished_at < now() - case p.raw
                                   when 'run' then interval '10 minutes'
                                   else (p.raw || ' days')::interval
                                 end
     and exists (select 1 from public.data_access_log l where l.tenant_id = r.tenant_id and l.run_id = r.id);
  return v_n;
end $$;
revoke all on function public.purge_db_raw_results(integer) from public, anon, authenticated;
grant execute on function public.purge_db_raw_results(integer) to service_role;

create or replace function public.purge_db_chat_answers(p_batch_limit integer default 500)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n integer;
begin
  with policy as (
    select s.tenant_id, s.chat_retention as chat from public.tenant_db_settings s
     where s.chat_retention in ('90', '30')
    union all
    select l.tenant_id, '30' from (select distinct tenant_id from public.data_access_log) l
     where not exists (select 1 from public.tenant_db_settings s where s.tenant_id = l.tenant_id)
  ),
  targets as (
    select m.id
      from public.agent_thread_messages m
      join policy p on p.tenant_id = m.tenant_id
     where m.sender_role = 'assistant'
       and m.agent_run_id is not null
       and m.created_at < now() - (p.chat || ' days')::interval
       and exists (select 1 from public.data_access_log l
                    where l.tenant_id = m.tenant_id and l.run_id = m.agent_run_id and l.sent_to_ai)
     limit greatest(1, least(p_batch_limit, 2000))
  )
  delete from public.agent_thread_messages m using targets where m.id = targets.id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.purge_db_chat_answers(integer) from public, anon, authenticated;
grant execute on function public.purge_db_chat_answers(integer) to service_role;

update public.connector_metadata set team_name = 'Your database'
 where slug = 'operator_db' and team_name = 'Operator DB';

commit;
