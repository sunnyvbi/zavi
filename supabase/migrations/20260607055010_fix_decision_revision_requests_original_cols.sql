
alter table decision_revision_requests
  add column if not exists original_decision_class text,
  add column if not exists original_handler        text,
  add column if not exists original_body           jsonb not null default '{}'::jsonb;

create index if not exists decision_revision_requests_run_idx
  on decision_revision_requests (tenant_id, agent_run_id)
  where agent_run_id is not null;
