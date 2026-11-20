begin;
set local lock_timeout = '5s';
create index if not exists praxis_logs_created_idx
  on public.praxis_logs (created_at);
commit;
