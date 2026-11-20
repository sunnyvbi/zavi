
begin;

create table if not exists utilization_metric_config (
  tenant_id              uuid primary key references tenants(id) on delete cascade,
  source_epoch           bigint not null,
  supply_table           text not null,
  supply_key_field       text not null,
  location_fields        text[] not null,
  active_field           text,
  active_values          jsonb,
  occupancy_table        text not null,
  occupancy_unit_field   text not null,
  occupancy_start_field  text not null,
  occupancy_end_field    text not null,
  occupancy_status_field text,
  occupying_values       jsonb,
  confirmed_by           uuid not null,
  confirmed_at           timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
alter table utilization_metric_config enable row level security;
drop policy if exists utilization_metric_config_select on utilization_metric_config;
create policy utilization_metric_config_select on utilization_metric_config
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = utilization_metric_config.tenant_id)
  );

create or replace function _utilization_scalar_list_ok(p jsonb) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select p is not null
     and jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) between 1 and 64
     and not exists (
       select 1 from jsonb_array_elements(p) e
        where jsonb_typeof(e) not in ('string', 'number', 'boolean')
           or (jsonb_typeof(e) = 'string' and length(e #>> '{}') not between 1 and 128)
     );
$$;

create or replace function confirm_utilization_metric_config(
  p_tenant_id uuid,
  p_confirmed_by uuid,
  p_expected_updated_at timestamptz,
  p_source_epoch bigint,
  p_supply_table text,
  p_supply_key_field text,
  p_location_fields text[],
  p_active_field text,
  p_active_values jsonb,
  p_occupancy_table text,
  p_occupancy_unit_field text,
  p_occupancy_start_field text,
  p_occupancy_end_field text,
  p_occupancy_status_field text,
  p_occupying_values jsonb
) returns utilization_metric_config
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row utilization_metric_config;
  v_cur utilization_metric_config;
  v_field text;
  v_epoch bigint;
  v_ident constant text := '^[A-Za-z_][A-Za-z0-9_.]{0,127}$';
begin
  if p_tenant_id is null or p_confirmed_by is null or p_source_epoch is null then
    raise exception 'confirm_utilization_metric_config: tenant, confirmer and source epoch required' using errcode = '22023';
  end if;
  if not exists (select 1 from tenant_users
                 where user_id = p_confirmed_by and tenant_id = p_tenant_id
                   and role in ('owner', 'admin')) then
    raise exception 'confirm_utilization_metric_config: confirmer is not an owner or admin of tenant'
      using errcode = '42501';
  end if;
  if p_location_fields is null or cardinality(p_location_fields) not between 1 and 3 then
    raise exception 'confirm_utilization_metric_config: 1 to 3 location fields required' using errcode = '22023';
  end if;
  foreach v_field in array array[p_supply_table, p_supply_key_field, p_occupancy_table, p_occupancy_unit_field,
                                 p_occupancy_start_field, p_occupancy_end_field] || p_location_fields loop
    if v_field is null or v_field !~ v_ident then
      raise exception 'confirm_utilization_metric_config: bad field or table name' using errcode = '22023';
    end if;
  end loop;
  if p_occupancy_start_field = p_occupancy_end_field then
    raise exception 'confirm_utilization_metric_config: start and end must be different fields' using errcode = '22023';
  end if;
  if (p_active_field is null) <> (p_active_values is null)
     or (p_active_field is not null and (p_active_field !~ v_ident or not _utilization_scalar_list_ok(p_active_values))) then
    raise exception 'confirm_utilization_metric_config: an active field needs 1 to 64 active values (or neither)' using errcode = '22023';
  end if;
  if (p_occupancy_status_field is null) <> (p_occupying_values is null)
     or (p_occupancy_status_field is not null and (p_occupancy_status_field !~ v_ident or not _utilization_scalar_list_ok(p_occupying_values))) then
    raise exception 'confirm_utilization_metric_config: a status field needs 1 to 64 occupying values (or neither)' using errcode = '22023';
  end if;

  select coalesce((select g.source_epoch from tenant_db_generation g where g.tenant_id = p_tenant_id for share), 0)
    into v_epoch;
  if v_epoch <> p_source_epoch then
    raise exception 'confirm_utilization_metric_config: the database source changed since it was read'
      using errcode = 'P0002';
  end if;

  perform 1 from tenants t where t.id = p_tenant_id for update;
  select * into v_cur from utilization_metric_config c where c.tenant_id = p_tenant_id for update;
  if (v_cur.tenant_id is null) <> (p_expected_updated_at is null)
     or (v_cur.tenant_id is not null and v_cur.updated_at <> p_expected_updated_at) then
    raise exception 'confirm_utilization_metric_config: the saved map changed since it was read'
      using errcode = 'P0002';
  end if;

  insert into utilization_metric_config as m (
    tenant_id, source_epoch, supply_table, supply_key_field, location_fields, active_field, active_values,
    occupancy_table, occupancy_unit_field, occupancy_start_field, occupancy_end_field,
    occupancy_status_field, occupying_values, confirmed_by, confirmed_at, updated_at
  ) values (
    p_tenant_id, p_source_epoch, p_supply_table, p_supply_key_field, p_location_fields, p_active_field, p_active_values,
    p_occupancy_table, p_occupancy_unit_field, p_occupancy_start_field, p_occupancy_end_field,
    p_occupancy_status_field, p_occupying_values, p_confirmed_by, now(), clock_timestamp()
  )
  on conflict (tenant_id) do update set
    source_epoch           = excluded.source_epoch,
    supply_table           = excluded.supply_table,
    supply_key_field       = excluded.supply_key_field,
    location_fields        = excluded.location_fields,
    active_field           = excluded.active_field,
    active_values          = excluded.active_values,
    occupancy_table        = excluded.occupancy_table,
    occupancy_unit_field   = excluded.occupancy_unit_field,
    occupancy_start_field  = excluded.occupancy_start_field,
    occupancy_end_field    = excluded.occupancy_end_field,
    occupancy_status_field = excluded.occupancy_status_field,
    occupying_values       = excluded.occupying_values,
    confirmed_by           = excluded.confirmed_by,
    confirmed_at           = excluded.confirmed_at,
    updated_at             = excluded.updated_at
  returning m.* into v_row;
  return v_row;
end;
$$;

revoke all on function _utilization_scalar_list_ok(jsonb) from public, anon, authenticated;
revoke all on function confirm_utilization_metric_config(uuid, uuid, timestamptz, bigint, text, text, text[], text, jsonb, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function confirm_utilization_metric_config(uuid, uuid, timestamptz, bigint, text, text, text[], text, jsonb, text, text, text, text, text, jsonb)
  to service_role;

commit;
