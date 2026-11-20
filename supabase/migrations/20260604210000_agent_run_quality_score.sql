
alter table agent_runs
  add column if not exists quality_score smallint,
  add column if not exists quality_rationale text,
  add column if not exists quality_model text,
  add column if not exists quality_scored_at timestamptz;

create index if not exists agent_runs_unscored_recent_idx
  on agent_runs (finished_at desc)
  where quality_score is null;
