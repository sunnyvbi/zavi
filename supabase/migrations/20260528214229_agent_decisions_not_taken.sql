
begin;

create type decision_rejection_type as enum (
  'autonomy_forbidden',
  'dedup_suppressed_24h',
  'cap_exceeded',
  'condition_unmet',
  'founder_override',
  'agent_not_emitted'
);

create table agent_decisions_not_taken (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  agent_run_id   uuid,
  agent_slug     text,
  decision_class text,
  rejection_type decision_rejection_type not null,
  reason_code    text,
  created_at     timestamptz not null default now()
);

create index agent_decisions_not_taken_tenant_idx
  on agent_decisions_not_taken (tenant_id, created_at desc);

alter table agent_decisions_not_taken enable row level security;

create policy agent_decisions_not_taken_tenant_select on agent_decisions_not_taken
  for select to authenticated using (
    exists (
      select 1 from tenant_users
      where tenant_users.tenant_id = agent_decisions_not_taken.tenant_id
        and tenant_users.user_id = auth.uid()
    )
  );

revoke insert, update, delete on agent_decisions_not_taken from authenticated, anon;
grant select on agent_decisions_not_taken to authenticated;
grant all on agent_decisions_not_taken to service_role;

commit;
