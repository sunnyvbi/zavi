
begin;

alter table conductor_runs drop constraint if exists conductor_runs_failure_class_check;
alter table conductor_runs
  add constraint conductor_runs_failure_class_check
  check (failure_class is null or failure_class in (
    'stage_failed',
    'dispatch_failed',
    'provider_capacity',
    'repair_exhausted',
    'acceptance_failed',
    'deploy_failed',
    'budget_halted',
    'class_cap_halted',
    'stale_reaped',
    'user_cancelled',
    'unknown',
    'provision_failed',
    'coach_precedence',
    'app_database_setup'
  ));

commit;
