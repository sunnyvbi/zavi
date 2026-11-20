
create table if not exists decision_revision_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  decision_id uuid not null references decisions(id) on delete cascade,
  agent_slug text not null default 'performance-marketer',
  thread_id uuid null references agent_threads(id) on delete set null,
  user_message_id uuid null references agent_thread_messages(id) on delete set null,
  agent_run_id uuid null references agent_runs(id) on delete set null,
  status text not null default 'requested',
  message text not null,
  original_decision_class text not null,
  original_handler text null,
  original_body jsonb not null default '{}'::jsonb,
  assistant_text text null,
  replacement_decision_id uuid null references decisions(id) on delete set null,
  last_error text null,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint decision_revision_requests_status_check
    check (status in ('requested','running','responded','revised','failed','cancelled'))
);

create index if not exists decision_revision_requests_decision_idx
  on decision_revision_requests (tenant_id, decision_id, created_at desc);

create index if not exists decision_revision_requests_status_idx
  on decision_revision_requests (tenant_id, status, created_at desc);

create index if not exists decision_revision_requests_run_idx
  on decision_revision_requests (tenant_id, agent_run_id)
  where agent_run_id is not null;

create unique index if not exists decision_revision_requests_one_active_idx
  on decision_revision_requests (tenant_id, decision_id)
  where status in ('requested','running');

alter table decision_revision_requests enable row level security;

drop policy if exists decision_revision_requests_member_select on decision_revision_requests;
create policy decision_revision_requests_member_select on decision_revision_requests
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.tenant_id = decision_revision_requests.tenant_id
        and tu.user_id = auth.uid()
    )
  );

revoke insert, update, delete on decision_revision_requests from authenticated;
grant select on decision_revision_requests to authenticated;
