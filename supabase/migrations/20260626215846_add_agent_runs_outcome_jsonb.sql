
alter table public.agent_runs
  add column if not exists outcome jsonb;

comment on column public.agent_runs.outcome is
  'Canonical structured run outcome (deliverable / side_effect / failure), written once by runner.persistTerminal. Nullable: old rows + reap/finalize writers leave it null and readers fall back to status. See src/services/agents/outcome-model.ts.';
