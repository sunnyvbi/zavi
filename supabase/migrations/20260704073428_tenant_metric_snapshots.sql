
begin;

create table tenant_metric_snapshots (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  metric_key   text not null,
  value        numeric,
  status       text not null default 'measured'
                 check (status in ('measured', 'unavailable')),
  source       text not null,
  window_kind  text not null
                 check (window_kind in ('rolling_7d', 'day', 'calendar_week', 'point')),
  window_start timestamptz,
  window_end   timestamptz not null,
  meta         jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  unique (tenant_id, metric_key, window_kind, window_end)
);

alter table tenant_metric_snapshots enable row level security;

create policy tenant_metric_snapshots_member_select on tenant_metric_snapshots
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = tenant_metric_snapshots.tenant_id
    )
  );

create policy tenant_metric_snapshots_active_tenant_restrict
  on tenant_metric_snapshots as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

commit;
