begin;
set local lock_timeout = '5s';
create index if not exists thread_event_prunable_created_idx
  on public.thread_event (created_at) where kind in ('tool_call', 'reasoning');
commit;
