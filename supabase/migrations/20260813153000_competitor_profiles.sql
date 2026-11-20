
begin;

create table if not exists competitor_profiles (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  domain               text not null check (length(btrim(domain)) between 1 and 255),
  website              text not null check (length(btrim(website)) between 1 and 2048),
  company_name         text not null check (length(btrim(company_name)) between 1 and 200),
  industry             text not null default '' check (length(industry) <= 200),
  positioning          text not null default '' check (length(positioning) <= 1200),
  target_audience      text not null default '' check (length(target_audience) <= 600),
  pricing              text not null default '' check (length(pricing) <= 400),
  acquisition_channels text[] not null default '{}',
  threat_level         text not null check (threat_level in ('low', 'medium', 'high')),
  source_urls          jsonb not null default '[]'::jsonb check (jsonb_typeof(source_urls) = 'array'),
  source_run_id        uuid references agent_runs(id) on delete set null,
  published_by         uuid not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (tenant_id, domain)
);

create index if not exists competitor_profiles_tenant_idx
  on competitor_profiles (tenant_id, updated_at desc);

alter table competitor_profiles enable row level security;

drop policy if exists competitor_profiles_member_select on competitor_profiles;
create policy competitor_profiles_member_select on competitor_profiles
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.tenant_id = competitor_profiles.tenant_id
        and tu.user_id = auth.uid()
    )
  );

revoke insert, update, delete on competitor_profiles from anon, authenticated;
grant select on competitor_profiles to authenticated;

commit;
