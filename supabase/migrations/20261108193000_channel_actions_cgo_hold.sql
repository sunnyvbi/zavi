
begin;

set lock_timeout = '5s';

alter table public.channel_actions add column if not exists cgo_hold jsonb;

commit;
