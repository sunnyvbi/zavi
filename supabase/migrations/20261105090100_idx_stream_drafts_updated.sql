begin;
set local lock_timeout = '5s';
create index if not exists agent_run_stream_drafts_updated_idx
  on public.agent_run_stream_drafts (updated_at);
commit;
