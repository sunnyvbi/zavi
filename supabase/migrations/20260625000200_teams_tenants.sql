
create table if not exists teams_tenants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  m365_tenant_id text not null,
  service_url text,
  install_conversation_reference jsonb,
  status text not null default 'enabled' check (status in ('enabled','deleted')),
  installed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teams_tenants_m365_unique unique (m365_tenant_id),
  constraint teams_tenants_tenant_unique unique (tenant_id)
);

create index if not exists teams_tenants_tenant_idx on teams_tenants(tenant_id);

alter table teams_tenants enable row level security;

drop policy if exists teams_tenants_select on teams_tenants;
create policy teams_tenants_select on teams_tenants
  for select
  using (
    tenant_id in (
      select tenant_id from tenant_users where user_id = auth.uid()
    )
  );

create or replace function set_teams_connection(
  p_tenant_id uuid,
  p_m365_tenant_id text,
  p_service_url text,
  p_install_conversation_reference jsonb
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into teams_tenants (
    tenant_id, m365_tenant_id, service_url,
    install_conversation_reference, status, installed_at
  )
  values (
    p_tenant_id, p_m365_tenant_id, p_service_url,
    p_install_conversation_reference, 'enabled', now()
  )
  on conflict (tenant_id) do update
    set m365_tenant_id = excluded.m365_tenant_id,
        service_url = coalesce(excluded.service_url, teams_tenants.service_url),
        install_conversation_reference =
          coalesce(excluded.install_conversation_reference, teams_tenants.install_conversation_reference),
        status = 'enabled',
        installed_at = coalesce(teams_tenants.installed_at, now()),
        updated_at = now();

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, 'teams', p_m365_tenant_id, null, array[]::text[], now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id,
                connected_at = excluded.connected_at;
end $$;

revoke all on function set_teams_connection(uuid, text, text, jsonb) from public;

create table if not exists teams_reply_claims (
  run_id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  replied_at timestamptz not null default now()
);

alter table teams_reply_claims enable row level security;
