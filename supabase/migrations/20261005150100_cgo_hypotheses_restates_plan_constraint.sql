
alter table cgo_hypotheses
  add column if not exists restates_plan_constraint boolean not null default false;

alter table cgo_hypotheses
  add column if not exists plan_constraint_marked_at timestamptz;
