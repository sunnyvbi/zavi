alter table public.autopilot_goals
  add column if not exists measure_source text
  check (measure_source is null or measure_source in ('booking_value', 'stripe_gross_revenue'));

comment on column public.autopilot_goals.measure_source is
  'Money goals: the source the founder picked (booking_value | stripe_gross_revenue). Null = no pick. 20261031180000.';
