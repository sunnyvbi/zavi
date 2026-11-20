
create table agent_prediction_signals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_run_id uuid not null references agent_runs(id) on delete cascade,
  agent_slug text not null,
  claim_text text not null check (length(claim_text) <= 280),
  predicted_at timestamptz not null default now(),
  audit_due_at timestamptz not null,
  outcome text check (outcome in ('came_true', 'did_not', 'unverifiable')) default null,
  outcome_at timestamptz,
  outcome_reason text,
  meta jsonb not null default '{}'::jsonb
);

create index agent_prediction_due_idx
  on agent_prediction_signals (audit_due_at)
  where outcome is null;
create index agent_prediction_tenant_slug_idx
  on agent_prediction_signals (tenant_id, agent_slug, predicted_at desc);

alter table agent_prediction_signals enable row level security;

create policy agent_prediction_member_select on agent_prediction_signals
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = agent_prediction_signals.tenant_id
    )
  );
