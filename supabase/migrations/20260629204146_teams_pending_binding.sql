
create table if not exists teams_pending_bindings (
  bind_code text primary key,
  m365_tenant_id text not null unique,
  service_url text,
  install_conversation_reference jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table teams_pending_bindings enable row level security;

create or replace function create_teams_pending_binding(
  p_m365_tenant_id text,
  p_service_url text,
  p_install_conversation_reference jsonb,
  p_bind_code text,
  p_ttl_seconds integer default 900
) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from teams_pending_bindings where m365_tenant_id = p_m365_tenant_id;
  insert into teams_pending_bindings (
    bind_code, m365_tenant_id, service_url,
    install_conversation_reference, expires_at
  )
  values (
    p_bind_code, p_m365_tenant_id, p_service_url,
    p_install_conversation_reference, now() + make_interval(secs => p_ttl_seconds)
  );
end $$;

revoke all on function create_teams_pending_binding(text, text, jsonb, text, integer) from public;

create or replace function confirm_teams_binding(
  p_tenant_id uuid,
  p_bind_code text
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_pending teams_pending_bindings%rowtype;
  v_existing_tenant uuid;
begin
  select * into v_pending
  from teams_pending_bindings
  where bind_code = p_bind_code and expires_at > now();

  if not found then
    return 'invalid_or_expired';
  end if;

  select tenant_id into v_existing_tenant
  from teams_tenants
  where m365_tenant_id = v_pending.m365_tenant_id and status = 'enabled';

  if v_existing_tenant is not null and v_existing_tenant <> p_tenant_id then
    return 'm365_already_bound';
  end if;

  perform set_teams_connection(
    p_tenant_id,
    v_pending.m365_tenant_id,
    v_pending.service_url,
    v_pending.install_conversation_reference
  );

  delete from teams_pending_bindings where bind_code = p_bind_code;
  return 'ok';
end $$;

revoke all on function confirm_teams_binding(uuid, text) from public;

do $$
begin
  raise notice '20260629204146: teams install-first binding (teams_pending_bindings + create/confirm RPCs); inert until MICROSOFT_APP_ID/PASSWORD set';
end $$;
