
create index if not exists conductor_runs_build_app_tenant_created_idx
  on conductor_runs (tenant_id, created_at desc)
  where kind = 'build_app';

create index if not exists conductor_runs_build_app_site_idx
  on conductor_runs (tenant_id, ((goal_graph->0->'payload'->>'site_id')), created_at desc)
  where kind = 'build_app';
