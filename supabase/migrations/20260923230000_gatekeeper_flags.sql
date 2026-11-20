
create table if not exists gatekeeper_flags (
  name text primary key
    check (name ~ '^[a-z0-9][a-z0-9_.-]{0,79}$'),
  description text not null default '',
  is_enabled boolean not null default false,
  rollout_percentage integer not null default 0
    check (rollout_percentage between 0 and 100),
  cache_policy text not null default 'standard'
    check (cache_policy in ('critical', 'standard')),
  whitelist uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table gatekeeper_flags enable row level security;
revoke all on gatekeeper_flags from public, anon, authenticated;
grant all on gatekeeper_flags to service_role;
