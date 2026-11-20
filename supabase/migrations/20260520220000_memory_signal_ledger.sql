
create table memory_signal (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  agent_run_id        uuid references agent_runs(id) on delete cascade,
  agent_slug          text not null,
  trigger             text not null,
  status              text not null,
  signal_kind         text not null default 'episode',
  trust_tier          smallint not null,
  redacted_trajectory jsonb not null,
  outcome             text,
  provenance          jsonb not null default '{}'::jsonb,
  distilled_at        timestamptz,
  created_at          timestamptz not null default now(),
  constraint memory_signal_status_chk  check (status in ('success','parse_failed','dispatch_error','failed')),
  constraint memory_signal_trigger_chk check (trigger in ('manual','cron','slack','webhook','a2a','chat','handoff','mcp')),
  constraint memory_signal_kind_chk    check (signal_kind in ('episode','gap','correction','outcome')),
  constraint memory_signal_trust_chk   check (trust_tier between 0 and 3)
);

create unique index memory_signal_episode_uq
  on memory_signal (agent_run_id, signal_kind)
  where signal_kind = 'episode' and agent_run_id is not null;

create index memory_signal_tenant_idx      on memory_signal (tenant_id, created_at desc);
create index memory_signal_run_idx         on memory_signal (agent_run_id);
create index memory_signal_undistilled_idx on memory_signal (tenant_id, created_at) where distilled_at is null;
create index memory_signal_gap_idx         on memory_signal (tenant_id, status) where status <> 'success';

alter table memory_signal enable row level security;
