
alter table public.autopilot_goals
  add column if not exists value_kind text,
  add column if not exists value_period_start date;

alter table public.autopilot_goals
  drop constraint if exists autopilot_goals_value_kind_check;
alter table public.autopilot_goals
  add constraint autopilot_goals_value_kind_check
  check (
    (value_kind is null and value_period_start is null)
    or (value_kind = 'gauge' and value_period_start is null)
    or (value_kind = 'period_total' and value_period_start is not null)
  ) not valid;

comment on column public.autopilot_goals.value_kind is
  'What a typed number means: gauge (running level from the baseline) or period_total (a total since value_period_start). Founder-set; null = not said.';
comment on column public.autopilot_goals.value_period_start is
  'The day a period_total number started again at 0. Set only when value_kind = period_total.';
