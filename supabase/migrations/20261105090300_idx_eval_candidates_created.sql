begin;
set local lock_timeout = '5s';
create index if not exists eval_candidates_created_idx
  on public.eval_candidates (created_at);
commit;
