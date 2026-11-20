
begin;

create table if not exists company_profiles (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null unique references tenants(id) on delete cascade,
  domain           text not null check (length(btrim(domain)) between 1 and 255),
  website          text not null check (length(btrim(website)) between 1 and 2048),
  industry         text not null default '' check (length(industry) <= 200),
  category         text not null default '' check (length(category) <= 200),
  founded          text not null default '' check (length(founded) <= 40),
  location         text not null default '' check (length(location) <= 200),
  social_profiles  jsonb not null default '[]'::jsonb check (jsonb_typeof(social_profiles) = 'array'),
  source_urls      jsonb not null default '[]'::jsonb check (jsonb_typeof(source_urls) = 'array'),
  source_run_id    uuid references agent_runs(id) on delete set null,
  published_by     uuid not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists company_profiles_updated_idx
  on company_profiles (updated_at desc);

alter table company_profiles enable row level security;

drop policy if exists company_profiles_member_select on company_profiles;
create policy company_profiles_member_select on company_profiles
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.tenant_id = company_profiles.tenant_id
        and tu.user_id = auth.uid()
    )
  );

revoke insert, update, delete on company_profiles from anon, authenticated;
grant select on company_profiles to authenticated;

commit;
