begin;
set local lock_timeout = '5s';
create index if not exists agent_run_events_prunable_created_idx
  on public.agent_run_events (created_at) where stage <> 'tool_use_completed';
commit;
