
create index if not exists agent_runs_tenant_slug_enqueued
  on agent_runs (tenant_id, agent_slug, enqueued_at desc);
