begin;
set local lock_timeout = '5s';
create index if not exists code_index_state_committed_idx
  on public.code_index_state (indexed_at) where current_build_id is not null;
commit;
