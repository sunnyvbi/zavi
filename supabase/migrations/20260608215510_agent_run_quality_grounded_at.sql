
alter table agent_runs
  add column if not exists quality_grounded_at timestamptz;

create index if not exists agent_runs_ungrounded_recent_idx
  on agent_runs (finished_at desc)
  where quality_grounded_at is null and quality_score is not null;
