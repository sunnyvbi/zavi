begin;
set local lock_timeout = '5s';
create index if not exists memory_search_trace_created_idx
  on public.memory_search_trace (created_at);
commit;
