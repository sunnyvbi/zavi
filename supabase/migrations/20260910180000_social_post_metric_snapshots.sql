
begin;

create table if not exists social_post_metric_snapshots (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  channel          text not null,
  external_post_id text not null,
  captured_on      date not null,
  posted_at        timestamptz,
  text             text,
  url              text,
  format           text,
  has_link         boolean not null default false,
  metrics          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  unique (tenant_id, channel, external_post_id, captured_on)
);

create index if not exists social_post_metric_snapshots_tenant_day_idx
  on social_post_metric_snapshots (tenant_id, channel, captured_on desc);

alter table social_post_metric_snapshots enable row level security;

drop policy if exists social_post_metric_snapshots_member_select on social_post_metric_snapshots;
create policy social_post_metric_snapshots_member_select on social_post_metric_snapshots
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = social_post_metric_snapshots.tenant_id
    )
  );

drop policy if exists social_post_metric_snapshots_active_tenant_restrict on social_post_metric_snapshots;
create policy social_post_metric_snapshots_active_tenant_restrict
  on social_post_metric_snapshots as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

commit;
