

create table thread_event (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_run_id uuid references agent_runs(id) on delete cascade,
  agent_slug text not null,
  kind text not null check (kind in (
    'chat_user',
    'chat_assistant',
    'run_start',
    'reasoning',
    'tool_call',
    'file_read',
    'file_edit',
    'file_create',
    'decision',
    'run_end'
  )),
  body jsonb not null,
  citations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index thread_event_agent_recency
  on thread_event (tenant_id, agent_slug, created_at desc, id desc);

create index thread_event_by_run
  on thread_event (agent_run_id, created_at)
  where agent_run_id is not null;

alter table thread_event enable row level security;

create policy thread_event_member_select on thread_event
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = thread_event.tenant_id
    )
  );

alter publication supabase_realtime add table thread_event;

comment on table thread_event is
  'Single append-only timeline table for the agents Chat tab. kind-discriminated body. citations are server-generated structured refs. Per /plan-eng-review cross-model T-1 (2026-05-10) — replaces the original plan-1 reasoning_text blob + UNION-ALL approach.';

comment on column thread_event.body is
  'kind-discriminated payload. See apps/backend/src/services/agents/thread-event-types.ts for Zod schemas per kind.';

comment on column thread_event.citations is
  'Server-generated array of {kind: "memory_doc"|"agent_run", ref: string, label: string}. Never parsed from model markdown.';
