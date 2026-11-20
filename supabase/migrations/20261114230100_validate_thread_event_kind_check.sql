set local lock_timeout = '5s';

alter table public.thread_event validate constraint thread_event_kind_check;
