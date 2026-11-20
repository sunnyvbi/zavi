alter table public.run_artifacts
  add column if not exists slack_delivered boolean not null default false;
