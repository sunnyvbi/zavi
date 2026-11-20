
alter table agent_runs
  add column if not exists batch_id uuid,
  add column if not exists parent_run_id uuid references agent_runs(id) on delete set null,
  add column if not exists child_index integer;

create table if not exists agent_run_batches (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  thread_id   uuid,
  status      text not null default 'proposed',
  task_specs  jsonb not null default '[]'::jsonb,
  rollup      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz,
  constraint agent_run_batches_status_chk
    check (status in ('proposed','approved','running','done','failed','cancelled'))
);

alter table agent_run_batches enable row level security;
