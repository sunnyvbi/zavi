
begin;

alter table autopilot_goals add column if not exists count_rule jsonb;
alter table autopilot_goals drop constraint if exists autopilot_goals_count_rule_shape;
alter table autopilot_goals add constraint autopilot_goals_count_rule_shape check (
  count_rule is null or (
    jsonb_typeof(count_rule) = 'object'
    and count_rule ->> 'dialect' in ('sql', 'mongodb')
    and count_rule ->> 'source' = 'operator_db'
    and char_length(coalesce(count_rule ->> 'definition', '')) between 1 and 160
    and pg_column_size(count_rule) <= 16384
  )
);

alter table cgo_questions add column if not exists count_rule jsonb;
alter table cgo_questions drop constraint if exists cgo_questions_count_rule_shape;
alter table cgo_questions add constraint cgo_questions_count_rule_shape check (
  count_rule is null or (
    jsonb_typeof(count_rule) = 'object'
    and count_rule ->> 'dialect' in ('sql', 'mongodb')
    and pg_column_size(count_rule) <= 16384
  )
);

comment on column autopilot_goals.count_rule is
  'Founder-confirmed counting rule (decision 8): run daily by goal-reconcile against the tenant''s own operator DB, read-only, one numeric result. Null = none.';
comment on column cgo_questions.count_rule is
  'The counting rule a count question asks the founder to confirm ({...rule, goal_id}). Saved on the goal only on a yes.';

do $$
begin
  raise notice '20260930170000: autopilot_goals.count_rule + cgo_questions.count_rule';
end $$;

commit;
