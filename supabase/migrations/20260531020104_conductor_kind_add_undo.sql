
alter table conductor_runs drop constraint if exists conductor_runs_kind_check;
alter table conductor_runs
  add constraint conductor_runs_kind_check
  check (kind in ('build_app','company_goal','undo'));
