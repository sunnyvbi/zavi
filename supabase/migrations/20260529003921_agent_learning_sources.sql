
create table agent_learning_sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_slug text not null,
  source_url text not null,
  domain_allowlist text[] not null default '{}',
  enabled boolean not null default false,
  fetch_cap int not null default 1,
  created_by uuid references auth.users(id),
  last_fetched timestamptz,
  content_hash text,
  etag text,
  failure_count int not null default 0,
  created_at timestamptz not null default now()
);

create index agent_learning_sources_by_tenant_agent_enabled
  on agent_learning_sources (tenant_id, agent_slug, enabled);

alter table agent_learning_sources enable row level security;

create policy agent_learning_sources_member_select on agent_learning_sources
  for select using (
    exists (select 1 from tenant_users tu
              where tu.user_id = auth.uid()
                and tu.tenant_id = agent_learning_sources.tenant_id)
  );
