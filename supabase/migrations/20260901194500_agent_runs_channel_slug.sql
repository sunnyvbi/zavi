
alter table agent_runs
  add column if not exists channel_slug text;

comment on column agent_runs.channel_slug is
  'Growth channel this run was dispatched for (registry slug, underscored, e.g. meta_ads). NULL = not a channel run. Written at enqueue, never from model output.';

do $$
begin
  raise notice '20260901194500: agent_runs.channel_slug added (nullable, no backfill, no index by design)';
end $$;
