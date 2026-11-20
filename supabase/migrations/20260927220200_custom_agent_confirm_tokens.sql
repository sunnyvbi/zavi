
begin;

create table custom_agent_confirm_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  code text not null check (code ~ '^[A-Z2-9]{8}$'),
  surface text not null check (surface in ('slack', 'whatsapp')),
  external_user_id text not null check (length(external_user_id) between 1 and 64),
  slack_team_id text,
  phone_number_id text,
  action text not null check (action in ('create', 'update')),
  agent_id uuid,
  draft jsonb not null check (jsonb_typeof(draft) = 'object'),
  draft_hash text not null check (draft_hash ~ '^[0-9a-f]{64}$'),
  origin jsonb not null default '{}'::jsonb,
  origin_run_id uuid references agent_runs(id) on delete set null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, code),
  constraint custom_agent_confirm_tokens_shape check (
    (surface = 'slack' and slack_team_id is not null)
    or (surface = 'whatsapp' and phone_number_id is not null)
  ),
  constraint custom_agent_confirm_tokens_action check (
    (action = 'create' and agent_id is null) or (action = 'update' and agent_id is not null)
  ),
  foreign key (agent_id, tenant_id) references custom_agents(id, tenant_id) on delete cascade
);

alter table custom_agent_confirm_tokens enable row level security;
revoke all on custom_agent_confirm_tokens from public, anon, authenticated;

commit;
