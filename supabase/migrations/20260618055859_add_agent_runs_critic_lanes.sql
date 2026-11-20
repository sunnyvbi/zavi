alter table public.agent_runs
  add column if not exists critic_lanes jsonb;

comment on column public.agent_runs.critic_lanes is
  'Cross-family deliberation critic lane status + revise_applied + critic_cost_usd (status-only telemetry; no errors/findings/content). NULL = single-lane or flag-off.';
