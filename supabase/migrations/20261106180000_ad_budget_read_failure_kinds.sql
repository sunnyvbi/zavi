alter table public.ad_budgets
  add column if not exists read_failure_kinds jsonb not null default '{}'::jsonb;
