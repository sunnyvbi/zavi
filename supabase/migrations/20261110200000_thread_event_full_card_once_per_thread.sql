begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
create unique index if not exists thread_event_full_card_once_per_thread
  on public.thread_event (tenant_id, thread_id, (body->>'decision_id'))
  where kind = 'decision' and (body->>'full_card') = 'true';
commit;
