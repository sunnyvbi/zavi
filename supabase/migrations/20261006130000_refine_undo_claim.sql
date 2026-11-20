create unique index if not exists conductor_runs_undo_claim_uq
  on conductor_runs (tenant_id, ((goal_graph->0->'payload'->>'parent_conductor_run_id')))
  where kind = 'undo'
    and status in ('proposed', 'done')
    and (goal_graph->0->'payload'->>'undo_claim') = 'true';
