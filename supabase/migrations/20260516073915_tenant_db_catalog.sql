
create table tenant_db_catalog (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  dialect operator_db_type not null,
  catalog jsonb not null default '{}'::jsonb,
  hints jsonb not null default '{}'::jsonb,
  discovered_at timestamptz,
  discovery_error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table tenant_db_catalog enable row level security;
create policy tenant_db_catalog_member_select on tenant_db_catalog
  for select using (
    exists (select 1 from tenant_users tu
            where tu.user_id = auth.uid() and tu.tenant_id = tenant_db_catalog.tenant_id)
  );

create or replace function set_tenant_db_catalog(
  p_tenant_id uuid,
  p_dialect text,
  p_catalog jsonb,
  p_hints jsonb,
  p_discovery_error text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into tenant_db_catalog (
    tenant_id, dialect, catalog, hints, discovery_error, discovered_at, updated_at
  )
  values (
    p_tenant_id, p_dialect::operator_db_type,
    coalesce(p_catalog, '{}'::jsonb), coalesce(p_hints, '{}'::jsonb),
    p_discovery_error,
    case when p_discovery_error is null then now() else null end,
    now()
  )
  on conflict (tenant_id)
  do update set
    dialect = excluded.dialect,
    catalog = excluded.catalog,
    hints = excluded.hints,
    discovery_error = excluded.discovery_error,
    discovered_at = case when excluded.discovery_error is null then now() else null end,
    updated_at = now();
end $$;
revoke all on function set_tenant_db_catalog(uuid, text, jsonb, jsonb, text) from public;

alter table tenant_db_config alter column schema_map drop not null;
alter table tenant_db_config alter column schema_map set default '{}'::jsonb;
