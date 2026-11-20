
create table memory_cards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  source_kind text not null check (source_kind in ('slack','meeting','email','doc')),
  source_ref text not null default '',
  source_url text,
  title text not null,
  body text not null default '',
  source_excerpt text not null default '',
  confidence text not null default 'medium' check (confidence in ('low','medium','high')),
  requested_by_external text,
  slack_team_id text,
  slack_channel_id text,
  slack_thread_ts text,
  status text not null default 'pending_review'
    check (status in ('pending_review','approved','ignored')),
  memory_note_id uuid,
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  content_hash text,
  created_at timestamptz not null default now()
);

create index memory_cards_tenant_pending_idx
  on memory_cards (tenant_id, created_at desc)
  where status = 'pending_review';
create unique index memory_cards_dedupe_idx
  on memory_cards (tenant_id, content_hash)
  where content_hash is not null and status = 'pending_review';

alter table memory_cards enable row level security;
create policy memory_cards_select on memory_cards
  for select to authenticated using (
    tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
  );
create policy memory_cards_active_tenant_restrict
  on memory_cards as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

alter table memory_note drop constraint if exists memory_note_source_check;
alter table memory_note add constraint memory_note_source_check check (
  source in (
    'human','agent_run','slack_distill','email_distill','operator_feedback',
    'praxis_staff','auto_distill_chat','auto_distill_agent_run','auto_distill_slack',
    'dream_cycle_merge','agent_write','gap_distill','episode_distill',
    'external_learning_distill','meeting_distill','memory_card_distill'
  )
);
