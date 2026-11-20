
set search_path = public;

alter table agent_runs
  add column if not exists needs_run_end_emit boolean not null default false;

comment on column agent_runs.needs_run_end_emit is
  'Set true by queued-stuck-scan when terminal UPDATE succeeded but thread_event run_end emit failed. Cleared by the watchdog (or any retry path) on successful emit. See migration 0067 + decisions/agent-flow-hardening-2026-05-14.md Phase A0 task 2.';

create index if not exists agent_runs_needs_run_end_emit
  on agent_runs (id)
  where needs_run_end_emit = true;
