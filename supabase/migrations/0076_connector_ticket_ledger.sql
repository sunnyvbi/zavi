
create table if not exists connector_ticket_ledger (
  tenant_id uuid not null references tenants(id) on delete cascade,
  connector text not null,
  external_key text not null,
  agent_run_id uuid references agent_runs(id) on delete set null,
  agent_slug text not null,
  last_seen_comment_at timestamptz,
  seen_comment_ids text[] not null default array[]::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, connector, external_key)
);

alter table connector_ticket_ledger enable row level security;
revoke all on connector_ticket_ledger from public;
