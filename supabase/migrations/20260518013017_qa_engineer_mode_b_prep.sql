

alter table public.tenant_agent_schedules
  add column if not exists payload_template jsonb not null default '{}'::jsonb;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'tenant_agent_schedules_payload_template_object_check') then
    alter table public.tenant_agent_schedules drop constraint tenant_agent_schedules_payload_template_object_check;
  end if;
end $$;
alter table public.tenant_agent_schedules
  add constraint tenant_agent_schedules_payload_template_object_check
  check (jsonb_typeof(payload_template) = 'object');

comment on column public.tenant_agent_schedules.payload_template is
  'Static payload merged into enqueueAgentRun({ payload }) by scheduled-runs.ts. Used by requires_sandbox agents (qa-engineer-weekly) to carry repo_hint + staging_origin without re-resolving on every cron fire. Object-only.';

alter table public.test_cases
  add column if not exists cached_steps_jsonb jsonb;

comment on column public.test_cases.cached_steps_jsonb is
  'Deterministic ops cache: [{op:"nav"|"click"|"fill"|...}, ...] matching browser_* tool surface. Replayed server-side by qa-engineer-weekly; bypasses LLM re-interpretation. cached_playwright text column (Sub-plan 1) kept for back-compat but unused by Mode B.';

revoke update on public.test_cases from authenticated;
grant update (title, role, nl_spec, tags) on public.test_cases to authenticated;

