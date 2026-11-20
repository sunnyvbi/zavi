
create table if not exists cgo_questions (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  topic_key        text not null check (char_length(topic_key) between 1 and 120),
  ask              text not null check (char_length(ask) between 1 and 400),
  default_action   jsonb,
  default_line     text check (default_line is null or char_length(default_line) <= 300),
  status           text not null default 'open'
                     check (status in ('open', 'answered', 'expired', 'withdrawn')),
  asked_run_id     uuid references agent_runs(id) on delete set null,
  asked_at         timestamptz not null default now(),
  expires_at       timestamptz not null,
  answered_at      timestamptz,
  answer           text check (answer is null or char_length(answer) <= 500),
  answered_via     text check (answered_via is null or answered_via in ('email', 'slack', 'chat')),
  resolved_run_id  uuid references agent_runs(id) on delete set null,
  default_applied  boolean not null default false,
  founder_replied_at timestamptz
);

create unique index if not exists cgo_questions_one_open_per_topic
  on cgo_questions (tenant_id, topic_key) where status = 'open';
create index if not exists cgo_questions_tenant_status_expires_idx
  on cgo_questions (tenant_id, status, expires_at);

alter table cgo_questions enable row level security;

create policy cgo_questions_member_select on cgo_questions
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = cgo_questions.tenant_id
    )
  );
create policy cgo_questions_active_tenant_restrict
  on cgo_questions as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);
revoke insert, update, delete on cgo_questions from anon, authenticated;

alter table cgo_notes add column if not exists refused text[] not null default '{}';

alter table slack_outbox add column if not exists recipient_slack_user text;
