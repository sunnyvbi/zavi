
begin;

alter table booking_metric_config
  add column if not exists completed_at_field   text,
  add column if not exists customer_ref_field   text,
  add column if not exists terminal_statuses    text[],
  add column if not exists outcome_basis        text,
  add column if not exists outcome_confirmed_by uuid,
  add column if not exists outcome_confirmed_at timestamptz;

create table if not exists outcome_rollup (
  tenant_id        uuid primary key references tenants(id) on delete cascade,
  basis            text not null,
  through_day      date not null,
  first_seen_floor timestamptz,
  source_watermark text not null default '',
  days             jsonb not null default '[]'::jsonb,
  refreshed_at     timestamptz not null default now()
);
alter table outcome_rollup enable row level security;
drop policy if exists outcome_rollup_select on outcome_rollup;
create policy outcome_rollup_select on outcome_rollup
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = outcome_rollup.tenant_id)
  );

create or replace function confirm_booking_outcome_fields(
  p_tenant_id uuid,
  p_completed_at_field text,
  p_customer_ref_field text,
  p_terminal_statuses text[],
  p_confirmed_by uuid,
  p_expected_updated_at timestamptz
) returns booking_metric_config
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row booking_metric_config;
  v_status text;
begin
  if p_tenant_id is null or p_confirmed_by is null or p_expected_updated_at is null then
    raise exception 'confirm_booking_outcome_fields: tenant and confirmer required' using errcode = '22023';
  end if;
  if not exists (select 1 from tenant_users
                 where user_id = p_confirmed_by and tenant_id = p_tenant_id
                   and role in ('owner', 'admin')) then
    raise exception 'confirm_booking_outcome_fields: confirmer is not an owner or admin of tenant'
      using errcode = '42501';
  end if;
  if p_completed_at_field is null or p_completed_at_field !~ '^[A-Za-z_][A-Za-z0-9_.]{0,127}$'
     or p_customer_ref_field is null or p_customer_ref_field !~ '^[A-Za-z_][A-Za-z0-9_.]{0,127}$' then
    raise exception 'confirm_booking_outcome_fields: bad field name' using errcode = '22023';
  end if;
  if p_terminal_statuses is null or cardinality(p_terminal_statuses) < 1
     or cardinality(p_terminal_statuses) > 64 then
    raise exception 'confirm_booking_outcome_fields: 1 to 64 finished statuses required' using errcode = '22023';
  end if;
  foreach v_status in array p_terminal_statuses loop
    if v_status is null or length(v_status) = 0 or length(v_status) > 128 then
      raise exception 'confirm_booking_outcome_fields: bad status value' using errcode = '22023';
    end if;
  end loop;

  update booking_metric_config c set
    completed_at_field   = p_completed_at_field,
    customer_ref_field   = p_customer_ref_field,
    terminal_statuses    = p_terminal_statuses,
    outcome_basis        = concat_ws('|', c.engine, c.booking_source, c.date_field, c.status_field),
    outcome_confirmed_by = p_confirmed_by,
    outcome_confirmed_at = now(),
    confirmed_by         = p_confirmed_by,
    updated_at           = now()
  where c.tenant_id = p_tenant_id
    and c.state = 'confirmed'
    and c.status_field is not null
    and c.updated_at = p_expected_updated_at
  returning c.* into v_row;

  if v_row.tenant_id is null then
    raise exception 'confirm_booking_outcome_fields: the booking mapping is not confirmed, has no status field, or changed since it was read'
      using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

revoke all on function confirm_booking_outcome_fields(uuid, text, text, text[], uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function confirm_booking_outcome_fields(uuid, text, text, text[], uuid, timestamptz)
  to service_role;

commit;
