alter table public.social_account_snapshots
  add column if not exists metrics jsonb;

alter table public.social_account_snapshots
  drop constraint if exists social_account_snapshots_metrics_object;

alter table public.social_account_snapshots
  add constraint social_account_snapshots_metrics_object
  check (metrics is null or jsonb_typeof(metrics) = 'object');
