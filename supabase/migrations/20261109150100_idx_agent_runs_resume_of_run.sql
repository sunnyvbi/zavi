begin;
set local lock_timeout = '5s';
create index if not exists agent_runs_resume_of_run_idx
  on public.agent_runs (tenant_id, (payload->>'resume_of_run_id'))
  where (payload->>'resume_of_run_id') is not null;
commit;
