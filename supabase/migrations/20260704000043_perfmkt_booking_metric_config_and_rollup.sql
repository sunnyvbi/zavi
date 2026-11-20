
begin;

create table if not exists booking_metric_config (
  tenant_id          uuid primary key references tenants(id) on delete cascade,
  engine             text not null check (engine in ('mongodb', 'postgres', 'mysql')),
  booking_source     text not null,
  date_field         text not null,
  status_field       text,
  completed_statuses text[] not null default '{}',
  revenue_field      text,
  refund_field       text,
  refund_basis       text not null default 'none'
                       check (refund_basis in ('none', 'booking_created_net', 'refund_event_day')),
  currency           text,
  reporting_timezone text not null default 'UTC',
  state              text not null default 'proposed'
                       check (state in ('proposed', 'confirmed')),
  confirmed_by       uuid,
  confirmed_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint booking_metric_config_confirmed_provenance
    check (state <> 'confirmed' or (confirmed_by is not null and confirmed_at is not null))
);

alter table booking_metric_config enable row level security;
drop policy if exists booking_metric_config_select on booking_metric_config;
create policy booking_metric_config_select on booking_metric_config
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = booking_metric_config.tenant_id)
  );

create table if not exists booking_daily_rollup (
  tenant_id      uuid not null references tenants(id) on delete cascade,
  day            date not null,
  bookings       numeric not null default 0,
  revenue_native numeric,
  currency       text,
  refreshed_at   timestamptz not null default now(),
  primary key (tenant_id, day)
);

create index if not exists booking_daily_rollup_tenant_day_idx
  on booking_daily_rollup (tenant_id, day desc);

alter table booking_daily_rollup enable row level security;
drop policy if exists booking_daily_rollup_select on booking_daily_rollup;
create policy booking_daily_rollup_select on booking_daily_rollup
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = booking_daily_rollup.tenant_id)
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
  p_confirm boolean
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
    state, confirmed_by, confirmed_at, updated_at
  ) values (
    p_tenant_id, p_engine, p_booking_source, p_date_field, p_status_field,
    coalesce(p_completed_statuses, '{}'), p_revenue_field, p_refund_field,
    coalesce(p_refund_basis, 'none'), p_currency, coalesce(p_reporting_timezone, 'UTC'),
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
    state = case when p_confirm then 'confirmed' else 'proposed' end,
    confirmed_by = case when p_confirm then auth.uid() else null end,
    confirmed_at = case when p_confirm then now() else null end,
    updated_at = now()
  returning c.* into v_row;

  return v_row;
end;
$$;

revoke all on function upsert_booking_metric_config(
  uuid, text, text, text, text, text[], text, text, text, text, text, boolean
) from public;
grant execute on function upsert_booking_metric_config(
  uuid, text, text, text, text, text[], text, text, text, text, text, boolean
) to authenticated;

insert into booking_metric_config (
  tenant_id, engine, booking_source, date_field, status_field, completed_statuses,
  revenue_field, refund_field, refund_basis, currency, reporting_timezone,
  state, confirmed_by, confirmed_at
)
select
  '73db45ff-457e-4541-bc8f-bdb625390204'::uuid, 'mongodb', 'trips', 'createdAt', 'status',
  array['completed','active','confirmed','ongoing','finished','payout_processed','in_progress'],
  'totalAmount', 'refundAmount', 'booking_created_net', 'USD', 'UTC',
  'confirmed', tu.user_id, now()
from tenant_users tu
where tu.tenant_id = '73db45ff-457e-4541-bc8f-bdb625390204'::uuid
order by tu.user_id
limit 1
on conflict (tenant_id) do nothing;

commit;
