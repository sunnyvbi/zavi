
set lock_timeout = '5s';

alter table public.memory_write_log drop constraint if exists memory_write_log_action_check;
alter table public.memory_write_log
  add constraint memory_write_log_action_check
  check (action in (
    'added', 'duplicate', 'updated', 'conflict', 'rejected', 'junk', 'cleanup_superseded',
    'proposed', 'proposal_expired'));

alter table public.memory_write_log
  add column if not exists decided_at timestamptz,
  add column if not exists candidate_tags text[],
  add column if not exists tool_call_key text
    check (tool_call_key is null or length(tool_call_key) <= 64);

comment on column public.memory_write_log.decided_at is
  'proposed rows only: when the distill extractor gave this proposal a verdict. Null = still pending.';
comment on column public.memory_write_log.candidate_tags is
  'proposed rows only: the tags the agent asked for.';
comment on column public.memory_write_log.tool_call_key is
  'proposed rows only: hash of the proposed title + body, so the same proposal in one run is queued once.';

create index if not exists memory_write_log_pending_proposal_idx
  on public.memory_write_log (tenant_id, run_id)
  where action = 'proposed' and decided_at is null;
create index if not exists memory_write_log_pending_proposal_age_idx
  on public.memory_write_log (created_at)
  where action = 'proposed' and decided_at is null;

create unique index if not exists memory_write_log_proposal_key_uq
  on public.memory_write_log (run_id, tool_call_key)
  where tool_call_key is not null;
