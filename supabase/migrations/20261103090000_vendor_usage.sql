
begin;

create table if not exists vendor_usage (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  tenant_id     uuid references tenants(id) on delete cascade,
  agent_run_id  uuid,
  source        text not null,
  vendor        text not null check (vendor in ('apify', 'dataforseo', 'tavily')),
  workload      text not null,
  units         int,
  ms            int,
  memory_mb     int,
  usd_est       numeric(12, 6),
  usd           numeric(12, 6),
  reconciled_at timestamptz
);

create index if not exists vendor_usage_created_idx on vendor_usage (created_at);
create index if not exists vendor_usage_tenant_created_idx on vendor_usage (tenant_id, created_at);

alter table vendor_usage enable row level security;
alter table vendor_usage force row level security;
revoke all on table vendor_usage from public, anon, authenticated;
grant all on table vendor_usage to service_role;

create table if not exists vendor_usage_alerts (
  key        text primary key,
  created_at timestamptz not null default now()
);
alter table vendor_usage_alerts enable row level security;
alter table vendor_usage_alerts force row level security;
revoke all on table vendor_usage_alerts from public, anon, authenticated;
grant all on table vendor_usage_alerts to service_role;

comment on table vendor_usage is
  'Outside-vendor spend per call (Apify/DataForSEO/Tavily). Tracking only: never billed. Service role only.';

create or replace function reconcile_vendor_usage_day(
  p_day      date,
  p_workload text,
  p_real_usd numeric
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_est  numeric;
  v_from timestamptz := p_day::timestamp at time zone 'utc';
  v_to   timestamptz := (p_day + 1)::timestamp at time zone 'utc';
begin
  delete from vendor_usage
   where vendor = 'apify' and workload = p_workload and source = 'unattributed'
     and created_at >= v_from and created_at < v_to;

  select coalesce(sum(usd_est), 0) into v_est
    from vendor_usage
   where vendor = 'apify' and workload = p_workload
     and created_at >= v_from and created_at < v_to;

  if v_est > 0 then
    update vendor_usage
       set usd = round(usd_est * p_real_usd / v_est, 6), reconciled_at = now()
     where vendor = 'apify' and workload = p_workload
       and created_at >= v_from and created_at < v_to;
    return 'scaled';
  end if;

  if p_real_usd > 0 then
    insert into vendor_usage (created_at, tenant_id, source, vendor, workload, usd_est, usd, reconciled_at)
    values (v_from + interval '12 hours', null, 'unattributed', 'apify', p_workload, 0, p_real_usd, now());
    return 'unattributed';
  end if;
  return 'nothing';
end;
$$;

revoke all on function reconcile_vendor_usage_day(date, text, numeric) from public, anon, authenticated;
grant execute on function reconcile_vendor_usage_day(date, text, numeric) to service_role;

create or replace function vendor_usage_apify_workloads(p_day date)
returns setof text
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct workload
    from vendor_usage
   where vendor = 'apify' and source <> 'unattributed'
     and created_at >= (p_day::timestamp at time zone 'utc')
     and created_at <  ((p_day + 1)::timestamp at time zone 'utc');
$$;

revoke all on function vendor_usage_apify_workloads(date) from public, anon, authenticated;
grant execute on function vendor_usage_apify_workloads(date) to service_role;

commit;
