
create table if not exists agent_open_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  thread_id uuid not null references agent_threads(id) on delete cascade,
  agent_slug text not null,
  source_run_id uuid references agent_runs(id) on delete set null,
  summary text not null,
  severity text not null check (severity in ('urgent', 'normal')),
  proposed_action text,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolved_at timestamptz,
  resolved_reason text,
  created_at timestamptz not null default now()
);

create index if not exists agent_open_actions_tenant_thread_status
  on agent_open_actions (tenant_id, thread_id, status);

alter table agent_open_actions enable row level security;

create policy agent_open_actions_member_select on agent_open_actions
  for select using (
    exists (select 1 from tenant_users tu
            where tu.user_id = auth.uid()
              and tu.tenant_id = agent_open_actions.tenant_id)
    and exists (select 1 from agent_threads t
                where t.id = agent_open_actions.thread_id
                  and t.user_id = auth.uid())
  );

revoke all on agent_open_actions from public;

update system_config
set blob = jsonb_set(
      coalesce(blob, '{}'::jsonb),
      '{open_actions_ledger_enabled}',
      coalesce(blob->'open_actions_ledger_enabled', 'false'::jsonb)
    ),
    updated_at = now()
where id = 1;
