
begin;

create table if not exists tenant_resources (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  resource_kind text not null
                  check (resource_kind in ('repo','hosting','db','stripe','email','ads','domain')),
  mode          text not null default 'connected'
                  check (mode in ('provisioned','connected')),
  status        text not null default 'pending'
                  check (status in ('pending','provisioning','ready','failed','teardown','torn_down')),
  provider      text,
  external_ref  jsonb not null default '{}'::jsonb,
  vault_key     text,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, resource_kind)
);

create index if not exists tenant_resources_tenant_idx
  on tenant_resources (tenant_id);

alter table tenant_resources enable row level security;
drop policy if exists tenant_resources_select on tenant_resources;
create policy tenant_resources_select on tenant_resources
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = tenant_resources.tenant_id)
  );

create or replace function set_tenant_resource(
  p_tenant_id     uuid,
  p_resource_kind text,
  p_mode          text,
  p_status        text,
  p_provider      text,
  p_external_ref  jsonb,
  p_vault_key     text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_tenant_id is null or p_resource_kind is null then
    raise exception 'set_tenant_resource: tenant_id and resource_kind are required'
      using errcode = '22023';
  end if;
  insert into tenant_resources (
    tenant_id, resource_kind, mode, status, provider, external_ref, vault_key, updated_at
  ) values (
    p_tenant_id, p_resource_kind,
    coalesce(p_mode, 'connected'), coalesce(p_status, 'pending'),
    p_provider, coalesce(p_external_ref, '{}'::jsonb), p_vault_key, now()
  )
  on conflict (tenant_id, resource_kind) do update
    set mode         = coalesce(excluded.mode, tenant_resources.mode),
        status       = coalesce(excluded.status, tenant_resources.status),
        provider     = excluded.provider,
        external_ref = excluded.external_ref,
        vault_key    = excluded.vault_key,
        updated_at   = now()
  returning id into v_id;
  return v_id;
end $$;
revoke all on function set_tenant_resource(uuid, text, text, text, text, jsonb, text) from public;
grant execute on function set_tenant_resource(uuid, text, text, text, text, jsonb, text) to service_role;

create or replace function set_tenant_resource_mode(
  p_tenant_id     uuid,
  p_resource_kind text,
  p_mode          text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_mode not in ('provisioned','connected') then
    raise exception 'set_tenant_resource_mode: mode must be provisioned|connected' using errcode = '22023';
  end if;
  if not exists (
    select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
  end if;
  insert into tenant_resources (tenant_id, resource_kind, mode, status)
  values (p_tenant_id, p_resource_kind, p_mode, 'pending')
  on conflict (tenant_id, resource_kind) do update
    set mode = excluded.mode, updated_at = now();
end $$;
revoke all on function set_tenant_resource_mode(uuid, text, text) from public;
grant execute on function set_tenant_resource_mode(uuid, text, text) to authenticated;

commit;
