
create table if not exists advisor_recommendations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  source_run_id uuid references agent_runs(id) on delete set null,
  thread_id uuid references agent_threads(id) on delete set null,
  title text not null,
  rationale text,
  lead_priority boolean not null default false,
  confidence text not null
    check (confidence in ('evidence_grounded', 'inference', 'low_confidence_speculation')),
  disconfirming_signal text,
  status text not null default 'open'
    check (status in ('open', 'acted', 'rejected', 'stale')),
  resolved_at timestamptz,
  resolved_run_id uuid references agent_runs(id) on delete set null,
  resolved_reason text,
  created_at timestamptz not null default now()
);

create index if not exists advisor_recommendations_tenant_status
  on advisor_recommendations (tenant_id, status, created_at desc);

alter table advisor_recommendations enable row level security;

create policy advisor_recommendations_member_select on advisor_recommendations
  for select using (
    exists (select 1 from tenant_users tu
            where tu.user_id = auth.uid()
              and tu.tenant_id = advisor_recommendations.tenant_id)
    and (
      advisor_recommendations.thread_id is null
      or exists (select 1 from agent_threads t
                 where t.id = advisor_recommendations.thread_id
                   and t.user_id = auth.uid())
    )
  );

revoke all on advisor_recommendations from public;

update system_config
set blob = jsonb_set(
      coalesce(blob, '{}'::jsonb),
      '{advisor_recommendation_ledger_enabled}',
      coalesce(blob->'advisor_recommendation_ledger_enabled', 'false'::jsonb)
    ),
    updated_at = now()
where id = 1;
