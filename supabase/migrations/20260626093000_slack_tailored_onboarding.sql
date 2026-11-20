
alter table slack_workspaces
  add column if not exists research_started_at      timestamptz,
  add column if not exists research_failed_at       timestamptz,
  add column if not exists research_run_id          text,
  add column if not exists tailored_dm_sent_at      timestamptz,
  add column if not exists channel_intro_posted_at  timestamptz,
  add column if not exists suppressed_reason        text;

create table if not exists slack_onboarding_drafts (
  tenant_id        uuid not null references tenants(id) on delete cascade,
  team_id          text not null,
  research_run_id  text,
  installer_user_id text,
  company_name     text,
  company_domain   text,
  research         jsonb not null default '{}'::jsonb,
  pitches          jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  primary key (tenant_id, team_id)
);

alter table slack_onboarding_drafts enable row level security;
