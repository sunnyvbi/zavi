
begin;

alter table booking_metric_config
  add column if not exists amount_unit text not null default 'dollars'
    check (amount_unit in ('dollars', 'cents'));

drop function if exists upsert_booking_metric_config(
  uuid, text, text, text, text, text[], text, text, text, text, text, boolean
);

create or replace function upsert_booking_metric_config(
  p_tenant_id uuid,
  p_engine    text,
  p_booking_source text,
  p_date_field text,
  p_status_field text,
  p_completed_statuses text[],
  p_revenue_field text,
  p_refund_field text,
  p_refund_basis text,
  p_currency text,
  p_reporting_timezone text,
  p_confirm boolean,
  p_amount_unit text default 'dollars'
) returns booking_metric_config
language plpgsql security definer set search_path = public as $$
declare v_row booking_metric_config;
begin
  if p_tenant_id is null then
    raise exception 'upsert_booking_metric_config: tenant_id required' using errcode = '22023';
  end if;
  if not exists (select 1 from tenant_users
                 where user_id = auth.uid() and tenant_id = p_tenant_id) then
    raise exception 'upsert_booking_metric_config: caller not a member of tenant'
      using errcode = '42501';
  end if;

  insert into booking_metric_config as c (
    tenant_id, engine, booking_source, date_field, status_field, completed_statuses,
    revenue_field, refund_field, refund_basis, currency, reporting_timezone,
    amount_unit, state, confirmed_by, confirmed_at, updated_at
  ) values (
    p_tenant_id, p_engine, p_booking_source, p_date_field, p_status_field,
    coalesce(p_completed_statuses, '{}'), p_revenue_field, p_refund_field,
    coalesce(p_refund_basis, 'none'), p_currency, coalesce(p_reporting_timezone, 'UTC'),
    coalesce(p_amount_unit, 'dollars'),
    case when p_confirm then 'confirmed' else 'proposed' end,
    case when p_confirm then auth.uid() else null end,
    case when p_confirm then now() else null end,
    now()
  )
  on conflict (tenant_id) do update set
    engine = excluded.engine,
    booking_source = excluded.booking_source,
    date_field = excluded.date_field,
    status_field = excluded.status_field,
    completed_statuses = excluded.completed_statuses,
    revenue_field = excluded.revenue_field,
    refund_field = excluded.refund_field,
    refund_basis = excluded.refund_basis,
    currency = excluded.currency,
    reporting_timezone = excluded.reporting_timezone,
    amount_unit = excluded.amount_unit,
    state = case when p_confirm then 'confirmed' else 'proposed' end,
    confirmed_by = case when p_confirm then auth.uid() else null end,
    confirmed_at = case when p_confirm then now() else null end,
    updated_at = now()
  returning c.* into v_row;

  return v_row;
end;
$$;

revoke all on function upsert_booking_metric_config(
  uuid, text, text, text, text, text[], text, text, text, text, text, boolean, text
) from public;
grant execute on function upsert_booking_metric_config(
  uuid, text, text, text, text, text[], text, text, text, text, text, boolean, text
) to authenticated;

drop function if exists propose_booking_metric_config(
  uuid, text, text, text, text, text[], text, text, text, text, text
);

create or replace function propose_booking_metric_config(
  p_tenant_id uuid,
  p_engine    text,
  p_booking_source text,
  p_date_field text,
  p_status_field text,
  p_completed_statuses text[],
  p_revenue_field text,
  p_refund_field text,
  p_refund_basis text,
  p_currency text,
  p_reporting_timezone text,
  p_amount_unit text default 'dollars'
) returns booking_metric_config
language plpgsql security definer set search_path = public as $$
declare v_row booking_metric_config;
begin
  if p_tenant_id is null then
    raise exception 'propose_booking_metric_config: tenant_id required' using errcode = '22023';
  end if;

  insert into booking_metric_config as c (
    tenant_id, engine, booking_source, date_field, status_field, completed_statuses,
    revenue_field, refund_field, refund_basis, currency, reporting_timezone,
    amount_unit, state, confirmed_by, confirmed_at, updated_at
  ) values (
    p_tenant_id, p_engine, p_booking_source, p_date_field, p_status_field,
    coalesce(p_completed_statuses, '{}'), p_revenue_field, p_refund_field,
    coalesce(p_refund_basis, 'none'), p_currency, coalesce(p_reporting_timezone, 'UTC'),
    coalesce(p_amount_unit, 'dollars'), 'proposed', null, null, now()
  )
  on conflict (tenant_id) do update set
    engine = excluded.engine,
    booking_source = excluded.booking_source,
    date_field = excluded.date_field,
    status_field = excluded.status_field,
    completed_statuses = excluded.completed_statuses,
    revenue_field = excluded.revenue_field,
    refund_field = excluded.refund_field,
    refund_basis = excluded.refund_basis,
    currency = excluded.currency,
    reporting_timezone = excluded.reporting_timezone,
    amount_unit = excluded.amount_unit,
    state = 'proposed',
    updated_at = now()
    where c.state <> 'confirmed'
  returning c.* into v_row;

  if v_row.tenant_id is null then
    select * into v_row from booking_metric_config where tenant_id = p_tenant_id;
  end if;
  return v_row;
end;
$$;

revoke all on function propose_booking_metric_config(
  uuid, text, text, text, text, text[], text, text, text, text, text, text
) from public;
grant execute on function propose_booking_metric_config(
  uuid, text, text, text, text, text[], text, text, text, text, text, text
) to service_role;

commit;
