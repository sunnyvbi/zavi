

alter table agent_runs
  add column if not exists needs_review boolean not null default true;

alter table decisions
  add column if not exists source_feedback_id uuid
    references agent_feedback(id) on delete set null;

alter table decisions
  add column if not exists source_thread_id uuid
    references agent_threads(id) on delete set null;

create index if not exists decisions_source_feedback_idx
  on decisions (source_feedback_id)
  where source_feedback_id is not null;

create table if not exists global_agent_rules (
  id uuid primary key default gen_random_uuid(),
  agent_slug text not null,
  body_markdown text not null check (length(body_markdown) between 1 and 4000),
  source_feedback_id uuid references agent_feedback(id) on delete set null,
  source_decision_id uuid references decisions(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'superseded')),
  proposed_by uuid not null,
  approved_by uuid,
  proposed_at timestamptz not null default now(),
  approved_at timestamptz,
  applied_to_tenants uuid[] not null default '{}'::uuid[]
);

create index if not exists global_agent_rules_status_idx
  on global_agent_rules (status, proposed_at desc);

create index if not exists global_agent_rules_slug_idx
  on global_agent_rules (agent_slug, status);

alter table global_agent_rules enable row level security;

revoke insert, update, delete on global_agent_rules from authenticated, anon;

insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values
  (
    'proposed_rule',
    'agent-coach proposed a rule to append to a tenant_agents body. Body: { rule_body_markdown, target_agent_slug, scope }. Approval gated; on approve, dispatch fires praxis.bake_rule which appends + retires prior active version.',
    'approval',
    'praxis.bake_rule'
  ),
  (
    'proposed_global_rule',
    'Trainer proposed a cross-tenant rule. Body: { rule_body_markdown, target_agent_slug, source_decision_id }. Approval gated by PRAXIS_GLOBAL_RULE_APPROVERS allowlist; on approve, applies per-tenant via approve_global_rule RPC. dispatch_handler is praxis.propose_global which is a no-op (the human flow handles promotion).',
    'approval',
    'praxis.propose_global'
  )
on conflict (slug) do nothing;
