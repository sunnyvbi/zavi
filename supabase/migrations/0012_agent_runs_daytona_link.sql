
alter table agent_runs
  add column if not exists daytona_workspace_id text;
