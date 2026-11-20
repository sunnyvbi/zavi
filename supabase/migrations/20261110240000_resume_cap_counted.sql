
begin;

set lock_timeout = '5s';

alter table public.decisions add column if not exists cap_counted jsonb;
alter table public.channel_actions add column if not exists cap_counted jsonb;

comment on column public.decisions.cap_counted is
  'A resume''s daily amount as dispatch counted it against the daily ad-change ceiling: {daily, currency}. Backend-written before the platform call.';
comment on column public.channel_actions.cap_counted is
  'A resume''s daily amount as dispatch counted it against the daily ad-change ceiling: {daily, currency}. Backend-written before the platform call.';

commit;
