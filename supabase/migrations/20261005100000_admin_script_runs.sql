
create table public.admin_script_runs (
  id uuid primary key default gen_random_uuid(),
  script_key text not null,
  args jsonb not null default '{}'::jsonb,
  lock_key text not null,
  mode text not null default 'apply' check (mode in ('dry_run', 'apply')),
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  run_by uuid not null,
  run_by_email text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  last_heartbeat_at timestamptz not null default now(),
  progress jsonb not null default '{}'::jsonb,
  summary jsonb,
  error text
);

create unique index admin_script_runs_one_running
  on public.admin_script_runs (script_key, lock_key)
  where status = 'running';

create index admin_script_runs_recent
  on public.admin_script_runs (script_key, started_at desc);

alter table public.admin_script_runs enable row level security;
revoke all on public.admin_script_runs from public, anon, authenticated;
grant select, insert, update, delete on public.admin_script_runs to service_role;
