
alter table agent_runs
  add column if not exists input_tokens_paged_baseline integer;

comment on column agent_runs.input_tokens_paged_baseline is
  'Snapshot of paged_baseline_snapshot.input_tokens at run time. NULL when paging flag is off for the tenant. Wave A — skill paging.';
