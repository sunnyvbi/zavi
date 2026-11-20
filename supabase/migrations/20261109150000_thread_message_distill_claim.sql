
begin;

set local lock_timeout = '5s';

alter table agent_thread_messages
  add column if not exists distill_claimed_at timestamptz;

comment on column agent_thread_messages.distill_claimed_at is
  'Lease taken by the distill-chat-turn worker before distilling this user message. Expires after 15 minutes; distilled_at marks the turn done.';

commit;
