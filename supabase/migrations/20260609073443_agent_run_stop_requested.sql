
alter table public.agent_runs
  add column if not exists stop_requested boolean not null default false;

comment on column public.agent_runs.stop_requested is
  'Set true by POST /api/agents/runs/:run_id/cancel; the worker PreToolUse policy aborts the run at the next tool boundary. Free-text status flips to cancelled.';
