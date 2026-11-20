
set search_path = public;

alter type agent_run_event_stage add value if not exists 'progress';

alter table agent_runs
  add column if not exists last_progress_at timestamptz null;

comment on column agent_runs.last_progress_at is
  'Updated by tg_agent_run_events_update_last_progress on every whitelisted progress event insert. NULL = no progress event yet (watchdog falls back to started_at). Used by queued-stuck-scan to detect stalled runs. See migration 0066.';

create index if not exists agent_runs_status_last_progress
  on agent_runs (status, last_progress_at)
  where status in ('queued', 'running');

create or replace function tg_agent_run_events_update_last_progress()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.stage in (
    'tool_use_completed',
    'tool_use_errored',
    'iter_cap_summarize',
    'progress'
  ) then
    update agent_runs
       set last_progress_at = NEW.created_at
     where id = NEW.agent_run_id;
  end if;
  return NEW;
end;
$$;

comment on function tg_agent_run_events_update_last_progress() is
  'Updates agent_runs.last_progress_at when an event lands in a whitelisted progress stage. tool_use_started is deliberately excluded: a retry loop emitting only starts would self-keepalive. See migration 0066 + decisions/agent-flow-hardening-2026-05-14.md.';

drop trigger if exists agent_run_events_update_last_progress on agent_run_events;
create trigger agent_run_events_update_last_progress
  after insert on agent_run_events
  for each row
  execute function tg_agent_run_events_update_last_progress();
