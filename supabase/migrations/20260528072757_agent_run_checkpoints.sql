
begin;

create table if not exists agent_run_checkpoints (
  id               uuid primary key default gen_random_uuid(),
  run_id           uuid not null references agent_runs(id) on delete cascade,
  tenant_id        uuid not null references tenants(id) on delete cascade,
  iter             int  not null,
  messages_jsonb   jsonb not null,
  usage            jsonb,
  last_stop_reason text,
  summary          text,
  created_at       timestamptz not null default now()
);

create unique index if not exists agent_run_checkpoints_run_iter_uq
  on agent_run_checkpoints (run_id, iter);

create index if not exists agent_run_checkpoints_run_idx
  on agent_run_checkpoints (run_id, iter desc);

create table if not exists agent_tool_effects (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references agent_runs(id) on delete cascade,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  tool_use_id  text not null,
  iter         int,
  tool_name    text not null,
  input_hash   text not null,
  status       text not null default 'pending'
                 check (status in ('pending', 'committed')),
  result       jsonb,
  created_at   timestamptz not null default now(),
  committed_at timestamptz
);

create unique index if not exists agent_tool_effects_key_uq
  on agent_tool_effects (run_id, tool_use_id);

create index if not exists agent_tool_effects_run_idx
  on agent_tool_effects (run_id);

alter table agent_run_checkpoints enable row level security;
alter table agent_tool_effects   enable row level security;

revoke all on agent_run_checkpoints from anon, authenticated;
revoke all on agent_tool_effects   from anon, authenticated;

commit;
