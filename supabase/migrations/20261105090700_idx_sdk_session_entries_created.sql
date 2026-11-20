begin;
set local lock_timeout = '5s';
create index if not exists sdk_session_entries_created_idx
  on public.sdk_session_entries (created_at, id);
commit;
