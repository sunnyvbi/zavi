
create table if not exists repeat_task_golden (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_slug text not null,
  query text not null,
  ideal_answer text not null,
  rubric jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index repeat_task_golden_tenant_active_idx
  on repeat_task_golden (tenant_id, active) where active;
create index repeat_task_golden_tenant_agent_idx
  on repeat_task_golden (tenant_id, agent_slug);

create table if not exists repeat_task_ab_metrics (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  agent_slug text not null,
  golden_id uuid not null,
  eval_run_id uuid not null,
  arm text not null,
  correctness_score numeric,
  model_cost_usd numeric,
  retrieval_cost_usd numeric,
  judge_cost_usd numeric,
  walltime_ms integer,
  terminal_status text,
  created_at timestamptz not null default now(),
  constraint repeat_task_ab_metrics_arm_chk check (arm in ('brain_on', 'brain_off')),
  constraint repeat_task_ab_metrics_golden_fk
    foreign key (tenant_id, golden_id)
    references repeat_task_golden (tenant_id, id) on delete cascade,
  constraint repeat_task_ab_metrics_run_golden_arm_uniq
    unique (tenant_id, eval_run_id, golden_id, arm)
);
create index repeat_task_ab_metrics_tenant_run_idx
  on repeat_task_ab_metrics (tenant_id, eval_run_id);
create index repeat_task_ab_metrics_golden_idx
  on repeat_task_ab_metrics (golden_id);

alter table repeat_task_golden enable row level security;
create policy repeat_task_golden_tenant_read on repeat_task_golden
  for select using (tenant_id = current_setting('app.tenant_id', true)::uuid);

alter table repeat_task_ab_metrics enable row level security;
create policy repeat_task_ab_metrics_tenant_read on repeat_task_ab_metrics
  for select using (tenant_id = current_setting('app.tenant_id', true)::uuid);

