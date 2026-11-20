

alter table team_members
  add column if not exists slack_iq_role    text,
  add column if not exists owned_areas      text[] default null,
  add column if not exists active_channels  text[] default null,
  add column if not exists last_active_at   timestamptz,
  add column if not exists expertise_summary text;

create index if not exists team_members_last_active_idx
  on team_members (tenant_id, last_active_at desc nulls last);

create index if not exists team_members_active_channels_gin_idx
  on team_members using gin (active_channels);
