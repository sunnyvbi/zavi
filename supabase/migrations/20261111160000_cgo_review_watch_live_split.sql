alter table public.cgo_review_watch_state
  add column if not exists real_count integer not null default 0,
  add column if not exists real_digest text not null default '0000000000000000';
delete from public.cgo_review_watch_state;
