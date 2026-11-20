alter table public.decisions
  add column if not exists dispatch_attempts integer not null default 0,
  add column if not exists dispatch_retry_since timestamptz,
  add column if not exists dispatch_retry_after timestamptz;

comment on column public.decisions.dispatch_attempts is
  'Failed tries of a retry_later dispatch; bounded in dispatch-decision.ts (DISPATCH_RETRY_MAX_ATTEMPTS).';
comment on column public.decisions.dispatch_retry_since is
  'First retry_later failure; the 24h retry bound counts from here.';
comment on column public.decisions.dispatch_retry_after is
  'A retry_later row is not drained before this time (backoff).';

alter table public.decisions
  add column if not exists dispatch_eligible_at timestamptz
  generated always as (coalesce(dispatch_retry_after, emitted_at)) stored;

comment on column public.decisions.dispatch_eligible_at is
  'Drain queue key: coalesce(dispatch_retry_after, emitted_at) (scanAutoCronRows).';

create index if not exists decisions_auto_drain_idx
  on public.decisions (dispatch_eligible_at asc nulls first, id)
  where status = 'proposed' and autonomy_at_emit = 'auto';
