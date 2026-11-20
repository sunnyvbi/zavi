
create table if not exists imessage_threads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  line text not null check (line ~ '^\+[1-9][0-9]{6,14}$'),
  handle text not null check (
    handle = lower(handle)
    and (handle ~ '^\+[1-9][0-9]{6,14}$' or handle ~ '^[^@[:space:]]+@[^@[:space:]]+$')
  ),
  status text not null default 'pending' check (status in ('pending','enabled','deleted')),
  confirm_code text,
  confirm_attempts int not null default 0,
  pending_expires_at timestamptz,
  bound_at timestamptz,
  bound_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint imessage_threads_identity_unique unique (line, handle)
);

create index if not exists imessage_threads_tenant_idx on imessage_threads(tenant_id);

alter table imessage_threads enable row level security;

create table if not exists imessage_link_tokens (
  token text primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  minted_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table imessage_link_tokens enable row level security;

create table if not exists imessage_reply_claims (
  run_id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  replied_at timestamptz not null default now()
);

alter table imessage_reply_claims enable row level security;

create or replace function create_imessage_link_token(
  p_tenant_id uuid,
  p_minted_by uuid,
  p_token text,
  p_ttl_seconds int default 900
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from imessage_link_tokens where tenant_id = p_tenant_id;
  delete from imessage_link_tokens where expires_at <= now();
  insert into imessage_link_tokens (token, tenant_id, minted_by, expires_at)
  values (p_token, p_tenant_id, p_minted_by, now() + make_interval(secs => p_ttl_seconds));
end $$;

create or replace function live_imessage_link_token(
  p_tenant_id uuid,
  p_minted_by uuid,
  p_min_seconds integer default 60
) returns table (token text, expires_in integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select t.token, floor(extract(epoch from (t.expires_at - now())))::integer
  from imessage_link_tokens t
  where t.tenant_id = p_tenant_id
    and t.minted_by = p_minted_by
    and t.expires_at > now() + make_interval(secs => p_min_seconds)
  order by t.created_at desc
  limit 1
$$;

create or replace function consume_imessage_link_token(
  p_token text,
  p_line text,
  p_handle text,
  p_confirm_code text
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row imessage_link_tokens%rowtype;
  v_existing_tenant uuid;
  v_existing_status text;
  v_existing_expires timestamptz;
begin
  delete from imessage_link_tokens
  where token = p_token and expires_at > now()
  returning * into v_row;

  if not found then
    return 'invalid_or_expired';
  end if;

  select tenant_id, status, pending_expires_at
    into v_existing_tenant, v_existing_status, v_existing_expires
  from imessage_threads
  where line = p_line and handle = p_handle;

  if v_existing_tenant is not null and v_existing_tenant <> v_row.tenant_id then
    if v_existing_status = 'deleted'
       or (v_existing_status = 'pending' and v_existing_expires is not null and v_existing_expires <= now()) then
      delete from imessage_threads where line = p_line and handle = p_handle;
      v_existing_status := null;
    else
      return 'owned_by_other_tenant';
    end if;
  end if;

  if v_existing_status = 'enabled' then
    return 'already_connected';
  end if;

  insert into imessage_threads (
    tenant_id, line, handle, status, confirm_code, confirm_attempts,
    pending_expires_at, bound_by_user_id
  )
  values (
    v_row.tenant_id, p_line, p_handle, 'pending', p_confirm_code, 0,
    v_row.expires_at, v_row.minted_by
  )
  on conflict (line, handle) do update
    set status = 'pending',
        confirm_code = excluded.confirm_code,
        confirm_attempts = 0,
        pending_expires_at = excluded.pending_expires_at,
        bound_by_user_id = excluded.bound_by_user_id,
        updated_at = now()
    where imessage_threads.tenant_id = excluded.tenant_id;

  if not found then
    return 'owned_by_other_tenant';
  end if;

  return 'ok';
end $$;

create or replace function confirm_imessage_bind(
  p_tenant_id uuid,
  p_confirm_code text
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_attempts int;
  v_expires timestamptz;
  v_line text;
  v_code text;
begin
  select id, confirm_attempts, pending_expires_at, line, confirm_code
    into v_id, v_attempts, v_expires, v_line, v_code
  from imessage_threads
  where tenant_id = p_tenant_id and status = 'pending'
  order by updated_at desc
  limit 1
  for update;

  if v_id is null then
    return 'no_pending';
  end if;

  if v_attempts >= 5 then
    return 'too_many_attempts';
  end if;

  if v_expires is not null and v_expires <= now() then
    update imessage_threads
       set status = 'deleted', confirm_code = null, pending_expires_at = null, updated_at = now()
     where id = v_id;
    return 'expired';
  end if;

  if coalesce(v_code, '') = ''
     or upper(regexp_replace(v_code,                        '[^A-Za-z0-9]', '', 'g'))
     <> upper(regexp_replace(coalesce(p_confirm_code, ''), '[^A-Za-z0-9]', '', 'g')) then
    update imessage_threads set confirm_attempts = confirm_attempts + 1, updated_at = now()
    where id = v_id;
    return 'bad_code';
  end if;

  update imessage_threads
     set status = 'enabled',
         bound_at = now(),
         confirm_code = null,
         confirm_attempts = 0,
         pending_expires_at = null,
         updated_at = now()
   where id = v_id;

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, 'imessage', v_line, null, array[]::text[], now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id,
                connected_at = excluded.connected_at;

  return 'ok';
end $$;

create or replace function unset_imessage_connection(p_tenant_id uuid)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_disabled integer;
begin
  if p_tenant_id is null then
    raise exception 'unset_imessage_connection: p_tenant_id is required';
  end if;

  update imessage_threads
     set status = 'deleted',
         confirm_code = null,
         confirm_attempts = 0,
         pending_expires_at = null,
         updated_at = now()
   where tenant_id = p_tenant_id
     and status <> 'deleted';
  get diagnostics v_disabled = row_count;

  delete from connector_metadata
   where tenant_id = p_tenant_id and slug = 'imessage';

  return v_disabled;
end $$;

create or replace function unset_imessage_thread(
  p_tenant_id uuid,
  p_thread_id uuid
) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_updated integer;
  v_left integer;
begin
  if p_tenant_id is null or p_thread_id is null then
    raise exception 'unset_imessage_thread: p_tenant_id and p_thread_id are required';
  end if;

  update imessage_threads
     set status = 'deleted',
         confirm_code = null,
         confirm_attempts = 0,
         pending_expires_at = null,
         updated_at = now()
   where id = p_thread_id
     and tenant_id = p_tenant_id
     and status <> 'deleted';
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    return null;
  end if;

  select count(*) into v_left
    from imessage_threads
   where tenant_id = p_tenant_id
     and status = 'enabled';

  if v_left = 0 then
    delete from connector_metadata
     where tenant_id = p_tenant_id and slug = 'imessage';
  end if;

  return v_left;
end $$;

revoke all on function create_imessage_link_token(uuid, uuid, text, int) from public, anon, authenticated;
grant execute on function create_imessage_link_token(uuid, uuid, text, int) to service_role;
revoke all on function live_imessage_link_token(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function live_imessage_link_token(uuid, uuid, integer) to service_role;
revoke all on function consume_imessage_link_token(text, text, text, text) from public, anon, authenticated;
grant execute on function consume_imessage_link_token(text, text, text, text) to service_role;
revoke all on function confirm_imessage_bind(uuid, text) from public, anon, authenticated;
grant execute on function confirm_imessage_bind(uuid, text) to service_role;
revoke all on function unset_imessage_connection(uuid) from public, anon, authenticated;
grant execute on function unset_imessage_connection(uuid) to service_role;
revoke all on function unset_imessage_thread(uuid, uuid) from public, anon, authenticated;
grant execute on function unset_imessage_thread(uuid, uuid) to service_role;

alter table agent_runs drop constraint if exists agent_runs_trigger_check;
alter table agent_runs
  add constraint agent_runs_trigger_check
  check (trigger in ('manual','cron','slack','webhook','a2a','chat','handoff','mcp','email','qa-weekly-execute','teams','playbook','telegram','discord','whatsapp','channel_recipe','imessage'));

alter table memory_signal drop constraint if exists memory_signal_trigger_chk;
alter table memory_signal
  add constraint memory_signal_trigger_chk
  check (trigger in ('manual','cron','slack','webhook','a2a','chat','handoff','mcp','email','qa-weekly-execute','teams','playbook','telegram','discord','whatsapp','imessage'));

create or replace function _is_engineer_backend_run(
  p_slug text, p_enqueued_by uuid, p_trigger text, p_payload jsonb
) returns boolean language sql immutable set search_path = public, pg_temp as $$
  select p_slug = 'engineer'
     and p_enqueued_by is null
     and (
       coalesce(p_trigger, '') not in ('chat','slack','teams','telegram','discord','whatsapp','imessage','email','manual')
       or coalesce(p_payload->>'kind', '') = 'engineer_pr_followup'
     )
$$;
revoke all on function _is_engineer_backend_run(text, uuid, text, jsonb) from public, anon, authenticated;

do $$
begin
  raise notice '20261105190000: imessage chat surface (threads, link tokens, reply claims, two-step bind RPCs, trigger admit)';
end $$;
