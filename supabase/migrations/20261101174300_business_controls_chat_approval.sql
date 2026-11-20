insert into public.decision_classes
  (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity)
values ('growth.save_business_controls', 'Review and save Business results and experiments settings.',
  'approval', null, true, false, 'high')
on conflict (slug) do update set default_autonomy='approval', dispatch_handler=null,
  never_auto=true, click_allowlistable=false;

create or replace function public.guard_business_controls_approval()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.decision_class = 'growth.save_business_controls'
     and new.status in ('approved','dispatching','dispatched','acted')
     and (tg_op='INSERT' or old.status is distinct from new.status)
     and current_setting('zavi.business_controls_approval',true) is distinct from new.id::text then
    raise exception 'Review the editable Business results card before saving' using errcode='42501';
  end if;
  return new;
end $$;
drop trigger if exists business_controls_approval_guard on public.decisions;
create trigger business_controls_approval_guard before insert or update on public.decisions
for each row execute function public.guard_business_controls_approval();

create or replace function public.approve_growth_business_controls(
  p_tenant_id uuid, p_actor uuid, p_decision_id uuid,
  p_policy jsonb, p_expected_policy jsonb, p_revision bigint
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare d public.decisions%rowtype; saved jsonb;
begin
  perform public._ad_budget_assert_manager(p_tenant_id,p_actor);
  perform 1 from public.tenants where id=p_tenant_id for update;
  select * into d from public.decisions where id=p_decision_id and tenant_id=p_tenant_id for update;
  if not found or d.decision_class <> 'growth.save_business_controls' then
    return jsonb_build_object('status','not_found');
  end if;
  if d.status='acted' and d.body ? 'saved_revision' then
    if d.body->'policy' is not distinct from p_policy
       and d.body->'proposed_policy' is not distinct from p_expected_policy
       and d.body->'revision' is not distinct from to_jsonb(p_revision) then
      return jsonb_build_object('status','saved','changed',false);
    end if;
    return jsonb_build_object('status','stale_card');
  end if;
  if d.status <> 'proposed' then return jsonb_build_object('status','stale_card'); end if;
  if p_expected_policy is null or p_revision is null
    or d.body->'policy' is distinct from p_expected_policy
    or d.body->'revision' is distinct from to_jsonb(p_revision) then
    return jsonb_build_object('status','stale_card');
  end if;
  saved := public.save_growth_business_policy(p_tenant_id,p_actor,p_policy,p_revision);
  if saved->>'status' <> 'saved' then return jsonb_build_object('status','stale_card'); end if;
  perform set_config('zavi.business_controls_approval',d.id::text,true);
  update public.decisions set
    body = d.body || jsonb_build_object('policy',p_policy,'proposed_policy',p_expected_policy,
      'saved_revision',saved->'revision','saved_at',now()),
    status='acted', approved_by=p_actor, approved_by_source=null,
    approved_at=now(), dispatched_at=now(), dispatch_error=null
    where id=d.id and tenant_id=p_tenant_id;
  insert into public.agent_thread_messages(thread_id,tenant_id,sender_role,body,meta)
  select t.id,p_tenant_id,'assistant',
    format('Business results and experiments settings saved (revision %s). Controls: %s; metric: %s; maximum CPA: $%s; minimum ROAS: %s. Minimum evidence: %s purchases, $%s spent, %s days. Exploration: %s%%; budget step: %s%%; reporting allowance: %s hours. Automatic stops: %s. Autopilot and the monthly budget were not changed; no experiment was registered.',
      saved->>'revision',case when (p_policy->>'enabled')::boolean then 'on' else 'off' end,
      upper(p_policy->>'metric'),p_policy->>'max_cpa_usd',p_policy->>'min_roas',
      p_policy->>'min_results',p_policy->>'min_spend_usd',p_policy->>'min_age_days',
      p_policy->>'exploration_percent',p_policy->>'step_percent',p_policy->>'reporting_delay_hours',
      case when (p_policy->>'automatic_stops')::boolean then 'on' else 'off' end),
    jsonb_build_object('business_controls_receipt',true,'decision_id',d.id,
      'policy',p_policy,'saved_revision',saved->'revision')
  from public.agent_runs r join public.agent_threads t on t.id::text=r.payload->>'thread_id'
  where r.id=d.agent_run_id and r.tenant_id=p_tenant_id and t.tenant_id=p_tenant_id;
  update public.agent_threads t set last_message_at=now()
  from public.agent_runs r
  where r.id=d.agent_run_id and r.tenant_id=p_tenant_id
    and t.id::text=r.payload->>'thread_id' and t.tenant_id=p_tenant_id;
  perform set_config('zavi.business_controls_approval','',true);
  return jsonb_build_object('status','saved','changed',true);
end $$;
revoke all on function public.guard_business_controls_approval() from public,anon,authenticated;
revoke all on function public.approve_growth_business_controls(uuid,uuid,uuid,jsonb,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.approve_growth_business_controls(uuid,uuid,uuid,jsonb,jsonb,bigint) to service_role;
