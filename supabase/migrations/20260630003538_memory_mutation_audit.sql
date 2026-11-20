
set search_path = public;

create table if not exists memory_mutation_audit (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  note_id         uuid not null,
  actor_user_id   uuid,
  action          text not null check (action in ('delete','edit','retire')),
  reason          text,
  before_snapshot jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

comment on table memory_mutation_audit is
  'Immutable who/when/why audit of memory_note delete/edit/retire mutations. delete before_snapshot is REDACTED (title hash, never body) for RTBF. No FK on note_id (a delete removes the note). See migration 20260630003538.';
comment on column memory_mutation_audit.before_snapshot is
  'delete: redacted ref (note_id, title_sha256, source, note_type, trust_tier, timestamps) — NEVER body_markdown. edit/retire: bounded snapshot of changed fields.';
comment on column memory_mutation_audit.actor_user_id is
  'Server-derived authed user (delete/edit routes); null for the agent-driven conversational retire path.';

create index if not exists memory_mutation_audit_tenant_idx
  on memory_mutation_audit (tenant_id, created_at desc);
create index if not exists memory_mutation_audit_note_idx
  on memory_mutation_audit (note_id);

alter table memory_mutation_audit enable row level security;
