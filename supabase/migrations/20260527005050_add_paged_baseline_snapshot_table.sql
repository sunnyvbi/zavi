
create table paged_baseline_snapshot (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_slug text not null,
  baseline_version int not null,
  prompt_hash text not null,
  input_tokens int not null,
  captured_at timestamptz not null default now(),
  unique (tenant_id, agent_slug, baseline_version)
);

comment on table paged_baseline_snapshot is
  'Frozen pre-paging input-token baseline per (tenant, agent, baseline_version). Reader: /staff/observability/token-budget computes savings vs agent_runs.input_tokens (live actual). Wave A — skill paging.';

alter table paged_baseline_snapshot enable row level security;

create policy paged_baseline_snapshot_member_select on paged_baseline_snapshot
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = paged_baseline_snapshot.tenant_id
    )
  );

grant select on paged_baseline_snapshot to authenticated;
grant all on paged_baseline_snapshot to service_role;
