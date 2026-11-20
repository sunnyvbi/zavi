
alter table public.agent_runs
  add column if not exists actor_user_id uuid references auth.users(id) on delete set null,
  add column if not exists actor_source  text;

comment on column public.agent_runs.actor_user_id is
  'Gap5: resolved auth.users.id of the human who triggered this run (NULL for cron/system or an unverified Slack sender). Attribution-only - gates nothing.';
comment on column public.agent_runs.actor_source is
  'Gap5: channel the trigger arrived through (slack|chat|approval|cron|system|...). Attribution-only.';

create index if not exists agent_runs_actor_user_id_idx
  on public.agent_runs (actor_user_id)
  where actor_user_id is not null;
