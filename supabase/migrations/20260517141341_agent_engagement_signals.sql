
create table agent_engagement_signals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_run_id uuid not null references agent_runs(id) on delete cascade,
  agent_slug text not null,
  signal_type text not null check (
    signal_type in (
      'viewed',
      'dismissed',
      'acted_on',
      'rating_up',
      'rating_down',
      'no_action_after_24h'
    )
  ),
  category text,
  captured_at timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb
);

create index agent_engagement_tenant_slug_idx
  on agent_engagement_signals (tenant_id, agent_slug, captured_at desc);
create index agent_engagement_run_idx
  on agent_engagement_signals (agent_run_id);

alter table agent_engagement_signals enable row level security;

create policy agent_engagement_member_select on agent_engagement_signals
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = agent_engagement_signals.tenant_id
    )
  );
