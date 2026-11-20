
create table if not exists whatsapp_threads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  phone_number_id text not null,
  wa_id text not null,
  display_name text,
  status text not null default 'pending' check (status in ('pending','enabled','deleted')),
  confirm_code text,
  confirm_attempts int not null default 0,
  pending_expires_at timestamptz,
  bound_at timestamptz,
  bound_by_user_id uuid,
  bound_by_wa_id text,
  last_inbound_at timestamptz,
  window_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_threads_identity_unique unique (phone_number_id, wa_id)
);

create index if not exists whatsapp_threads_tenant_idx on whatsapp_threads(tenant_id);

alter table whatsapp_threads enable row level security;

drop policy if exists whatsapp_threads_select on whatsapp_threads;
create policy whatsapp_threads_select on whatsapp_threads
  for select
  using (
    tenant_id in (
      select tenant_id from tenant_users where user_id = auth.uid()
    )
  );

create table if not exists whatsapp_link_tokens (
  token text primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  minted_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table whatsapp_link_tokens enable row level security;

create table if not exists whatsapp_reply_claims (
  run_id uuid primary key,
  claimed_at timestamptz not null default now()
);

alter table whatsapp_reply_claims enable row level security;

create or replace function set_whatsapp_connection(
  p_tenant_id uuid,
  p_phone_number_id text,
  p_wa_id text,
  p_display_name text default null,
  p_bound_by_user_id uuid default null,
  p_bound_by_wa_id text default null
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing_tenant uuid;
begin
  select tenant_id into v_existing_tenant
  from whatsapp_threads
  where phone_number_id = p_phone_number_id and wa_id = p_wa_id;

  if v_existing_tenant is not null and v_existing_tenant <> p_tenant_id then
    return 'owned_by_other_tenant';
  end if;

  insert into whatsapp_threads (
    tenant_id, phone_number_id, wa_id, display_name, status, bound_at,
    bound_by_user_id, bound_by_wa_id, confirm_code, confirm_attempts, pending_expires_at
  )
  values (
    p_tenant_id, p_phone_number_id, p_wa_id, p_display_name, 'enabled', now(),
    p_bound_by_user_id, p_bound_by_wa_id, null, 0, null
  )
  on conflict (phone_number_id, wa_id) do update
    set display_name = coalesce(excluded.display_name, whatsapp_threads.display_name),
        status = 'enabled',
        bound_at = coalesce(whatsapp_threads.bound_at, now()),
        bound_by_user_id = coalesce(excluded.bound_by_user_id, whatsapp_threads.bound_by_user_id),
        bound_by_wa_id = coalesce(excluded.bound_by_wa_id, whatsapp_threads.bound_by_wa_id),
        confirm_code = null,
        confirm_attempts = 0,
        pending_expires_at = null,
        updated_at = now();

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, 'whatsapp', p_phone_number_id, null, array[]::text[], now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id,
                connected_at = excluded.connected_at;

  return 'ok';
end $$;

revoke all on function set_whatsapp_connection(uuid, text, text, text, uuid, text) from public;

create or replace function create_whatsapp_link_token(
  p_tenant_id uuid,
  p_minted_by uuid,
  p_token text,
  p_ttl_seconds int default 900
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from whatsapp_link_tokens where tenant_id = p_tenant_id;
  delete from whatsapp_link_tokens where expires_at <= now();
  insert into whatsapp_link_tokens (token, tenant_id, minted_by, expires_at)
  values (p_token, p_tenant_id, p_minted_by, now() + make_interval(secs => p_ttl_seconds));
end $$;

revoke all on function create_whatsapp_link_token(uuid, uuid, text, int) from public;

create or replace function consume_whatsapp_link_token(
  p_token text,
  p_phone_number_id text,
  p_wa_id text,
  p_confirm_code text,
  p_display_name text default null
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row whatsapp_link_tokens%rowtype;
  v_existing_tenant uuid;
begin
  delete from whatsapp_link_tokens
  where token = p_token and expires_at > now()
  returning * into v_row;

  if not found then
    return 'invalid_or_expired';
  end if;

  delete from whatsapp_threads
  where phone_number_id = p_phone_number_id
    and wa_id = p_wa_id
    and status = 'pending'
    and pending_expires_at is not null
    and pending_expires_at <= now();

  select tenant_id into v_existing_tenant
  from whatsapp_threads
  where phone_number_id = p_phone_number_id and wa_id = p_wa_id;

  if v_existing_tenant is not null and v_existing_tenant <> v_row.tenant_id then
    return 'owned_by_other_tenant';
  end if;

  insert into whatsapp_threads (
    tenant_id, phone_number_id, wa_id, display_name, status,
    confirm_code, confirm_attempts, pending_expires_at, bound_by_user_id, bound_by_wa_id
  )
  values (
    v_row.tenant_id, p_phone_number_id, p_wa_id, p_display_name, 'pending',
    p_confirm_code, 0, v_row.expires_at, v_row.minted_by, p_wa_id
  )
  on conflict (phone_number_id, wa_id) do update
    set status = case when whatsapp_threads.status = 'enabled' then 'enabled' else 'pending' end,
        display_name = coalesce(excluded.display_name, whatsapp_threads.display_name),
        confirm_code = case when whatsapp_threads.status = 'enabled' then null else excluded.confirm_code end,
        confirm_attempts = 0,
        pending_expires_at = case when whatsapp_threads.status = 'enabled' then null else excluded.pending_expires_at end,
        updated_at = now();

  return 'ok';
end $$;

revoke all on function consume_whatsapp_link_token(text, text, text, text, text) from public;

create or replace function confirm_whatsapp_bind(
  p_tenant_id uuid,
  p_confirm_code text
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_attempts int;
  v_expires timestamptz;
  v_phone text;
  v_wa text;
  v_by uuid;
  v_code text;
begin
  select id, confirm_attempts, pending_expires_at, phone_number_id, wa_id, bound_by_user_id, confirm_code
    into v_id, v_attempts, v_expires, v_phone, v_wa, v_by, v_code
  from whatsapp_threads
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
    delete from whatsapp_threads where id = v_id;
    return 'expired';
  end if;

  if coalesce(v_code, '') = ''
     or upper(regexp_replace(v_code,          '[^A-Za-z0-9]', '', 'g'))
     <> upper(regexp_replace(coalesce(p_confirm_code, ''), '[^A-Za-z0-9]', '', 'g')) then
    update whatsapp_threads set confirm_attempts = confirm_attempts + 1, updated_at = now()
    where id = v_id;
    return 'bad_code';
  end if;

  return set_whatsapp_connection(p_tenant_id, v_phone, v_wa, null, v_by, v_wa);
end $$;

revoke all on function confirm_whatsapp_bind(uuid, text) from public;

create or replace function touch_whatsapp_window(
  p_phone_number_id text,
  p_wa_id text,
  p_ts timestamptz
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update whatsapp_threads
     set last_inbound_at = greatest(coalesce(last_inbound_at, p_ts), p_ts),
         window_expires_at = greatest(
           coalesce(window_expires_at, p_ts + interval '24 hours'),
           p_ts + interval '24 hours'
         ),
         updated_at = now()
   where phone_number_id = p_phone_number_id
     and wa_id = p_wa_id
     and status = 'enabled';
end $$;

revoke all on function touch_whatsapp_window(text, text, timestamptz) from public;

alter table agent_runs drop constraint if exists agent_runs_trigger_check;
alter table agent_runs
  add constraint agent_runs_trigger_check
  check (trigger in ('manual','cron','slack','webhook','a2a','chat','handoff','mcp','email','qa-weekly-execute','teams','playbook','telegram','discord','whatsapp'));

alter table memory_signal drop constraint if exists memory_signal_trigger_chk;
alter table memory_signal
  add constraint memory_signal_trigger_chk
  check (trigger in ('manual','cron','slack','webhook','a2a','chat','handoff','mcp','email','qa-weekly-execute','teams','playbook','telegram','discord','whatsapp'));
