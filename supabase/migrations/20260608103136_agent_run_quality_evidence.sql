
alter table agent_runs
  add column if not exists quality_evidence jsonb;
