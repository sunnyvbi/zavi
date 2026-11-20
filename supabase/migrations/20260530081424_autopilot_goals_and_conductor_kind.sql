
begin;

create table if not exists autopilot_goals (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  objective      text not null,
  target_metric  text not null,
  target_value   numeric not null,
  baseline_value numeric,
  current_value  numeric,
  due_date       date,
  status         text not null default 'active'
                   check (status in ('active','met','missed','paused')),
  priority       int not null default 50,
  source         text not null default 'founder'
                   check (source in ('founder','agent_proposed')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists autopilot_goals_tenant_status_idx
  on autopilot_goals (tenant_id, status, priority desc);

alter table autopilot_goals enable row level security;
drop policy if exists autopilot_goals_select on autopilot_goals;
create policy autopilot_goals_select on autopilot_goals
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = autopilot_goals.tenant_id)
  );

alter table conductor_runs
  add column if not exists kind text not null default 'build_app'
    check (kind in ('build_app','company_goal'));

alter table conductor_runs drop constraint if exists conductor_runs_status_check;
alter table conductor_runs
  add constraint conductor_runs_status_check
  check (status in ('provisioning','active','halted','done','failed','proposed'));

create or replace function set_autopilot_goal(
  p_tenant_id      uuid,
  p_objective      text,
  p_target_metric  text,
  p_target_value   numeric,
  p_baseline_value numeric,
  p_due_date       date,
  p_priority       int,
  p_source         text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_tenant_id is null or p_objective is null or p_target_metric is null
     or p_target_value is null then
    raise exception 'set_autopilot_goal: tenant_id/objective/target_metric/target_value required'
      using errcode = '22023';
  end if;
  if p_source is not null and p_source not in ('founder','agent_proposed') then
    raise exception 'set_autopilot_goal: source must be founder or agent_proposed (got %)', p_source
      using errcode = '22023';
  end if;
  insert into autopilot_goals (
    tenant_id, objective, target_metric, target_value, baseline_value,
    current_value, due_date, priority, source
  ) values (
    p_tenant_id, p_objective, p_target_metric, p_target_value, p_baseline_value,
    p_baseline_value, p_due_date,
    coalesce(p_priority, 50),
    coalesce(p_source, 'founder')
  ) returning id into v_id;
  return v_id;
end $$;

revoke all on function set_autopilot_goal(uuid, text, text, numeric, numeric, date, int, text) from public;
grant execute on function set_autopilot_goal(uuid, text, text, numeric, numeric, date, int, text) to service_role;

create or replace function update_goal_progress(
  p_goal_id       uuid,
  p_current_value numeric
) returns void
language plpgsql security definer set search_path = public as $$
declare v_target numeric; v_status text;
begin
  if p_goal_id is null or p_current_value is null then
    raise exception 'update_goal_progress: goal_id/current_value required'
      using errcode = '22023';
  end if;
  select target_value, status into v_target, v_status
  from autopilot_goals where id = p_goal_id;
  if v_target is null then
    return;
  end if;
  if v_status = 'met' or v_status = 'missed' then
    update autopilot_goals
       set current_value = p_current_value, updated_at = now()
     where id = p_goal_id;
    return;
  end if;
  update autopilot_goals
     set current_value = p_current_value,
         status = case when p_current_value >= v_target then 'met' else status end,
         updated_at = now()
   where id = p_goal_id;
end $$;

revoke all on function update_goal_progress(uuid, numeric) from public;
grant execute on function update_goal_progress(uuid, numeric) to service_role;

insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values (
  'autopilot.daily-plan',
  'CEO loop daily plan — chief-of-staff proposes a buildable plan-graph (conductor_runs.kind=company_goal). Founder approves → handler flips the staged conductor_runs row from proposed to active so the conductor-tick sweep picks it up. Approval-gated by default; never auto.',
  'approval',
  'autopilot.daily_plan_approve'
)
on conflict (slug) do nothing;

commit;
