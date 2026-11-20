
alter table tenant_db_catalog
  add column if not exists coverage jsonb not null default '{}'::jsonb;

comment on column tenant_db_catalog.coverage is
  'Discovery completeness, OUTSIDE catalog_hash: {tables_total, tables_indexed, skipped_unsafe_names, deadline_hit}. Empty object = unknown (pre-coverage row or a legacy 5-arg write).';

create or replace function set_tenant_db_catalog(
  p_tenant_id uuid,
  p_dialect text,
  p_catalog jsonb,
  p_hints jsonb,
  p_discovery_error text,
  p_coverage jsonb
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_catalog jsonb := coalesce(p_catalog, '{}'::jsonb);
  v_hints   jsonb := coalesce(p_hints,   '{}'::jsonb);
  v_cov     jsonb := coalesce(p_coverage, '{}'::jsonb);
  v_hash    text  := md5(p_dialect || v_catalog::text || v_hints::text);
begin
  insert into tenant_db_catalog (
    tenant_id, dialect, catalog, hints, catalog_hash, coverage,
    discovery_error, discovered_at, updated_at
  )
  values (
    p_tenant_id, p_dialect::operator_db_type, v_catalog, v_hints, v_hash, v_cov,
    p_discovery_error,
    case when p_discovery_error is null then now() else null end,
    now()
  )
  on conflict (tenant_id)
  do update set
    dialect = excluded.dialect,
    catalog = excluded.catalog,
    hints = excluded.hints,
    catalog_hash = excluded.catalog_hash,
    coverage = excluded.coverage,
    discovery_error = excluded.discovery_error,
    discovered_at = case when excluded.discovery_error is null then now() else null end,
    updated_at = now();
end $$;

revoke all on function set_tenant_db_catalog(uuid, text, jsonb, jsonb, text, jsonb)
  from public, anon, authenticated;
grant execute on function set_tenant_db_catalog(uuid, text, jsonb, jsonb, text, jsonb)
  to service_role;

create or replace function set_tenant_db_catalog(
  p_tenant_id uuid,
  p_dialect text,
  p_catalog jsonb,
  p_hints jsonb,
  p_discovery_error text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform set_tenant_db_catalog(
    p_tenant_id, p_dialect, p_catalog, p_hints, p_discovery_error, '{}'::jsonb
  );
end $$;
revoke all on function set_tenant_db_catalog(uuid, text, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function set_tenant_db_catalog(uuid, text, jsonb, jsonb, text)
  to service_role;
