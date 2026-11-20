
create table praxis_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  level text not null check (level in ('error', 'warn', 'info')),
  source text not null,
  code text,
  message text,
  tenant_id uuid references tenants(id) on delete cascade,
  run_id uuid,
  meta jsonb not null default '{}'::jsonb
);

create index praxis_logs_level_created_idx on praxis_logs (level, created_at desc);
create index praxis_logs_tenant_created_idx
  on praxis_logs (tenant_id, created_at desc) where tenant_id is not null;

alter table praxis_logs enable row level security;

create policy praxis_logs_member_select on praxis_logs
  for select using (
    tenant_id is not null
    and exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = praxis_logs.tenant_id
    )
  );

