
create table public.agent_setup_state (
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_slug text not null,
  last_blocked_at timestamptz not null default now(),
  missing_vault_keys text[] not null default '{}'::text[],
  missing_connectors text[] not null default '{}'::text[],
  blocked_run_id uuid references agent_runs(id) on delete set null,
  primary key (tenant_id, agent_slug)
);

comment on table public.agent_setup_state is
  'Per-tenant per-agent setup-block state. Written by generic-dispatcher pre-flight when required vault/connectors missing; consumed by SettingsTab (Sub-plan 5.3) + the setup-completion endpoint (which reuses blocked_run_id payload for retry).';

alter table public.agent_setup_state enable row level security;

create policy agent_setup_state_member_select on public.agent_setup_state
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = agent_setup_state.tenant_id
    )
  );

