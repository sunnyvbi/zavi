begin;
set local lock_timeout = '5s';
drop index if exists public.thread_event_founder_card_once;
commit;
