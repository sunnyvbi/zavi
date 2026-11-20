begin;

create table if not exists company_profile_fields (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  key            text not null check (key ~ '^[a-z_]{1,64}$'),
  value          text not null check (length(btrim(value)) between 1 and 1000),
  method         text not null default 'inferred' check (method in ('recorded', 'calculated', 'inferred')),
  source         text not null default '' check (length(source) <= 300),
  formula        text not null default '' check (length(formula) <= 500),
  inputs         jsonb not null default '[]'::jsonb check (jsonb_typeof(inputs) = 'array'),
  assumptions    text not null default '' check (length(assumptions) <= 2000),
  caveats        text not null default '' check (length(caveats) <= 2000),
  confidence     text check (confidence in ('low', 'medium', 'high')),
  status         text not null default 'ai_estimated' check (status in ('ai_estimated', 'human_confirmed')),
  evidence       jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  source_run_id  uuid references agent_runs(id) on delete set null,
  reviewed_by    uuid not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, key)
);

create index if not exists company_profile_fields_tenant_idx
  on company_profile_fields (tenant_id, updated_at desc);

alter table company_profile_fields enable row level security;
revoke all on table company_profile_fields from public, anon, authenticated;
grant all on table company_profile_fields to service_role;

commit;
