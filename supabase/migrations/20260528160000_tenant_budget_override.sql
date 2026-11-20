
create table if not exists tenant_budget_override (
  tenant_id     uuid primary key references tenants(id) on delete cascade,
  daily_cap_usd numeric(18, 6) not null check (daily_cap_usd >= 0),
  note          text,
  updated_at    timestamptz not null default now()
);

alter table tenant_budget_override enable row level security;

drop policy if exists tenant_budget_override_select on tenant_budget_override;
create policy tenant_budget_override_select on tenant_budget_override
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid()
              and tenant_id = tenant_budget_override.tenant_id)
  );
