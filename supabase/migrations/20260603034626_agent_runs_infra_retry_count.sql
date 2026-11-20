alter table agent_runs
  add column if not exists infra_retry_count smallint not null default 0;
