begin;

alter table public.growth_experiment_controls
  add column kind text not null default 'registered',
  add column envelope jsonb,
  add column ends_on date,
  add column source_action_id uuid,
  add column billing_scope text,
  add column parent_object_id text,
  add column failing_since timestamptz,
  alter column policy_revision drop not null;

alter table public.growth_experiment_controls
  add constraint growth_experiment_controls_kind_check check (kind in ('registered','test_stop')),
  add constraint growth_experiment_controls_billing_scope_check check (billing_scope is null or billing_scope in ('object','campaign_budget')),
  add constraint growth_experiment_registered_fields check (kind = 'test_stop' or policy_revision is not null),
  add constraint growth_experiment_test_stop_fields check (kind = 'registered' or (
    envelope is not null and jsonb_typeof(envelope) = 'object' and ends_on is not null
    and source_action_id is not null and decision_id is not null and billing_scope is not null));

alter table public.growth_experiment_controls drop constraint growth_experiment_controls_platform_check;
alter table public.growth_experiment_controls add constraint growth_experiment_controls_platform_check
  check (platform in ('meta','google','chatgpt','tiktok'));
alter table public.growth_experiment_controls drop constraint growth_experiment_controls_level_check;
alter table public.growth_experiment_controls add constraint growth_experiment_controls_level_check
  check (level in ('campaign','ad_set','ad_group'));
alter table public.growth_experiment_controls drop constraint growth_experiment_controls_state_check;
alter table public.growth_experiment_controls add constraint growth_experiment_controls_state_check
  check (state in ('monitoring','stopping','stop_failed','stopped','needs_attention','object_gone','founder_resumed'));

create unique index growth_test_stop_action_object on public.growth_experiment_controls
  (tenant_id, source_action_id, platform, account_id, object_id) where kind = 'test_stop';
create index growth_test_stop_open on public.growth_experiment_controls (tenant_id)
  where kind = 'test_stop' and stopped_at is null;
create index growth_test_stop_closed on public.growth_experiment_controls (stopped_at, tenant_id)
  where kind = 'test_stop' and stopped_at is not null;

create or replace function public.test_stop_tenants(p_since timestamptz, p_after uuid, p_limit int)
returns setof uuid language sql stable security definer set search_path = public, pg_temp as $$
  select t from (
    select tenant_id t from growth_experiment_controls where kind = 'test_stop' and stopped_at is null
    union
    select tenant_id from growth_experiment_controls where kind = 'test_stop' and stopped_at >= p_since
  ) x
  where p_after is null or t > p_after
  order by t
  limit least(greatest(coalesce(p_limit, 500), 1), 1000)
$$;
revoke all on function public.test_stop_tenants(timestamptz, uuid, int) from public, anon, authenticated;
grant execute on function public.test_stop_tenants(timestamptz, uuid, int) to service_role;

create or replace function public.arm_growth_test_stop(p_tenant_id uuid, p_action_id uuid, p_spec jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_decision uuid := nullif(p_spec->>'decision_id','')::uuid;
  v_platform text := p_spec->>'platform';
  v_level text := p_spec->>'level';
  v_object text := nullif(trim(p_spec->>'object_id'),'');
  v_account text := nullif(trim(p_spec->>'account_id'),'');
  v_id uuid;
  v_scope text := p_spec->>'billing_scope';
  v_env jsonb := p_spec->'envelope';
  v_amount numeric := (p_spec->'envelope'->>'amount_usd')::numeric;
  v_ends date := (p_spec->>'ends_on')::date;
  v_started timestamptz := coalesce(nullif(p_spec->>'started_at','')::timestamptz, now());
  v_test jsonb;
begin
  if p_action_id is null or v_decision is null or v_object is null or v_account is null or v_platform not in ('meta','google','chatgpt','tiktok')
     or v_level not in ('campaign','ad_set','ad_group') or v_scope not in ('object','campaign_budget')
     or jsonb_typeof(v_env) is distinct from 'object' or v_amount is null or v_amount <= 0 or v_ends is null then
    raise exception 'invalid test stop spec' using errcode = '22023';
  end if;
  select body->'test' into v_test from decisions
   where tenant_id = p_tenant_id and id = v_decision and decision_class = 'cgo.dispatch-specialist';
  if not found then raise exception 'test stop names no cgo order of this tenant' using errcode = '22023'; end if;
  if not exists (
    select 1 from channel_actions a join agent_runs r on r.id = a.run_id and r.tenant_id = p_tenant_id
     where a.id = p_action_id and a.tenant_id = p_tenant_id
       and coalesce(r.source_decision_id, nullif(r.payload->>'source_decision_id','')::uuid) = v_decision
    union all
    select 1 from decisions x join agent_runs r on r.id = x.agent_run_id and r.tenant_id = p_tenant_id
     where x.id = p_action_id and x.tenant_id = p_tenant_id
       and coalesce(r.source_decision_id, nullif(r.payload->>'source_decision_id','')::uuid) = v_decision
  ) then
    raise exception 'test stop action is not this tenant''s or not a run of its order' using errcode = '22023';
  end if;
  if v_started > now() + interval '5 minutes' then v_started := now(); end if;
  if v_ends::timestamptz <= v_started or v_ends::timestamptz > v_started + interval '30 days' then
    raise exception 'test stop end % is outside its window', v_ends using errcode = '22023';
  end if;
  insert into growth_experiment_controls (
    tenant_id, kind, decision_id, name, hypothesis, platform, account_id, object_id, level,
    budget_usd, baseline, stop_on_loss, started_at, ends_at, policy_revision,
    envelope, ends_on, source_action_id, billing_scope, parent_object_id)
  values (
    p_tenant_id, 'test_stop', v_decision,
    left(coalesce(nullif(trim(p_spec->>'name'),''), nullif(trim(v_test->>'variable'),''), 'Zavi test'), 160),
    left(coalesce(nullif(trim(v_test->>'success_if'),''), 'Zavi test'), 500),
    v_platform, v_account, v_object, v_level,
    round(v_amount, 2),
    jsonb_build_object('date', to_char((v_started at time zone 'UTC')::date - 1, 'YYYY-MM-DD'), 'amounts', '{}'::jsonb),
    false, v_started, v_ends::timestamptz, null,
    v_env, v_ends, p_action_id, v_scope, nullif(trim(p_spec->>'parent_object_id'),''))
  on conflict do nothing
  returning id into v_id;
  if v_id is not null then return jsonb_build_object('status','armed','id',v_id); end if;
  select id into v_id from growth_experiment_controls
   where tenant_id = p_tenant_id and kind = 'test_stop' and source_action_id = p_action_id
     and platform = v_platform and account_id = v_account and object_id = v_object
     and stopped_at is null and state in ('monitoring','needs_attention') and stop_requested_at is null
     and decision_id = v_decision and level = v_level and billing_scope = v_scope
     and ends_on <= v_ends and ends_at > now() and round(v_amount, 2) <= budget_usd;
  if v_id is not null then return jsonb_build_object('status','exists','id',v_id); end if;
  raise exception 'no open stop matches this attempt (it fired, differs, or another control holds the object)' using errcode = '23505';
end $$;

create or replace function public.close_test_stop_on_founder_resume()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_platform text;
  v_id text;
  v_status text;
begin
  if new.approved_by is not null and coalesce(new.approved_by_source, 'founder') in ('founder', 'email')
     and upper(coalesce(new.exec_payload->>'status','')) in ('ACTIVE','ENABLED','ENABLE') then
    v_platform := case split_part(new.exec_class, '.', 1)
      when 'meta_ads' then 'meta' when 'google_ads' then 'google'
      when 'chatgpt_ads' then 'chatgpt' when 'tiktok_ads' then 'tiktok' end;
    v_id := coalesce(new.exec_payload->>'object_id', new.exec_payload->>'adgroup_id', new.exec_payload->>'ad_group_id', new.exec_payload->>'campaign_id');
    if v_platform is not null and v_id is not null then
      update growth_experiment_controls e
         set state = 'founder_resumed', stopped_at = coalesce(e.stopped_at, now()), checked_at = now(),
             reason = 'You switched it back on, so Zavi no longer pauses it for this test.'
       where e.tenant_id = new.tenant_id and e.kind = 'test_stop' and e.platform = v_platform
         and e.stop_requested_at is not null and e.state not in ('founder_resumed','object_gone')
         and (e.object_id = v_id or e.object_id in (
           select c.campaign_id from ad_campaigns c
            where c.tenant_id = new.tenant_id and c.platform = v_platform and c.object_id = v_id and c.campaign_id is not null));
    end if;
  end if;
  return new;
end $$;
revoke all on function public.arm_growth_test_stop(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.arm_growth_test_stop(uuid, uuid, jsonb) to service_role;
revoke all on function public.close_test_stop_on_founder_resume() from public, anon, authenticated;
drop trigger if exists channel_actions_test_stop_resume on public.channel_actions;
create trigger channel_actions_test_stop_resume after update on public.channel_actions
  for each row
  when (new.exec_status = 'executed' and old.exec_status is distinct from 'executed' and new.exec_class like '%.set_status')
  execute function public.close_test_stop_on_founder_resume();

create or replace function public.register_growth_experiment(p_tenant_id uuid, p_actor uuid, p_experiment jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare p growth_business_policies%rowtype; v_id uuid; v_amount numeric; o ad_campaigns%rowtype; v_decision uuid; v_test jsonb; v_target text;
begin
  if p_actor is not null then perform _ad_budget_assert_manager(p_tenant_id,p_actor); end if;
  select * into p from growth_business_policies where tenant_id=p_tenant_id for update;
  if not found or not (p.policy->>'enabled')::boolean or not (p.policy->>'automatic_stops')::boolean then
    raise exception 'Save business controls and automatic-stop permission first' using errcode='22023';
  end if;
  if nullif(p_experiment->>'policy_revision','')::bigint is distinct from p.revision then return jsonb_build_object('status','conflict'); end if;
  v_decision := nullif(p_experiment->>'decision_id','')::uuid;
  if v_decision is not null and not exists (select 1 from decisions where tenant_id=p_tenant_id and id=v_decision and decision_class='cgo.dispatch-specialist') then
    raise exception 'Experiment must reference this workspace CGO decision' using errcode='22023';
  end if;
  if p_actor is null and v_decision is null then raise exception 'An agent experiment needs its source decision' using errcode='22023'; end if;
  select id into v_id from growth_experiment_controls where tenant_id=p_tenant_id and decision_id=v_decision
    and platform=p_experiment->>'platform' and account_id=p_experiment->>'account_id' and object_id=p_experiment->>'object_id';
  if found then return jsonb_build_object('status','created','id',v_id); end if;
  select * into o from ad_campaigns where tenant_id=p_tenant_id and source='api'
    and platform=p_experiment->>'platform' and account_id=p_experiment->>'account_id' and object_id=p_experiment->>'object_id';
  if not found or o.budget_kind <> 'daily' or o.currency <> 'USD' or coalesce(o.budget_usd,0)<=0
    or o.as_of < now()-interval '3 hours' or o.as_of>now() or o.level is distinct from p_experiment->>'level' then
    raise exception 'A fresh dedicated daily USD budget is required' using errcode='22023';
  end if;
  if exists (select 1 from growth_experiment_controls e where e.tenant_id=p_tenant_id
      and e.platform=o.platform
      and (e.stopped_at is null or e.stopped_at+make_interval(hours=>(p.policy->>'reporting_delay_hours')::int+24)>now())
      and (e.account_id=o.account_id or e.kind='test_stop')
      and (e.object_id=o.object_id or e.object_id=o.campaign_id or exists (
        select 1 from ad_campaigns c where c.tenant_id=p_tenant_id and c.platform=o.platform and c.account_id=o.account_id
          and c.source='api' and c.campaign_id=o.object_id and c.object_id=e.object_id))) then
    raise exception 'This campaign budget already belongs to an experiment' using errcode='22023';
  end if;
  if jsonb_typeof(p_experiment->'baseline'->'amounts') is distinct from 'object'
    or p_experiment->'baseline'->>'date' is null
    or (p_experiment->'baseline'->>'date')::date not between current_date-2 and current_date
    or jsonb_typeof(p_experiment->'stop_on_loss') is distinct from 'boolean'
    or exists (select 1 from jsonb_each(p_experiment->'baseline'->'amounts') b where jsonb_typeof(b.value)<>'number' or (b.value#>>'{}')::numeric<0) then
    raise exception 'Invalid experiment baseline or stop rule' using errcode='22023';
  end if;
  if not exists (select 1 from ad_budgets where tenant_id=p_tenant_id and status='active') then raise exception 'Active Growth budget required' using errcode='22023'; end if;
  v_amount := (p_experiment->>'budget_usd')::numeric;
  if v_decision is not null then
    select body->'test',body->>'target_agent_slug' into v_test,v_target from decisions where tenant_id=p_tenant_id and id=v_decision;
    if (v_test ? 'stop_if' and not (v_test ? 'stop_rule'))
      or (p_experiment->>'stop_on_loss')::boolean is distinct from coalesce(v_test->>'stop_rule'='business_loss',false)
      or (p_experiment->>'ends_at')::timestamptz > ((v_test->>'readout_on')::date+1)::timestamptz
      or v_target is null or not (case p_experiment->>'platform' when 'meta' then v_target='meta_ads' when 'google' then v_target in ('google_ads','youtube_ads') when 'chatgpt' then v_target='chatgpt_ads' else false end) then
      raise exception 'Experiment exceeds its CGO source channel or deadline' using errcode='22023';
    end if;
  end if;
  if v_amount is null or v_amount <= o.budget_usd*2*((p.policy->>'reporting_delay_hours')::numeric+1)/24 then
    raise exception 'The experiment budget must cover this daily rate and the reporting allowance' using errcode='22023';
  end if;
  insert into growth_experiment_controls(tenant_id,decision_id,name,hypothesis,platform,account_id,object_id,level,
    budget_usd,baseline,stop_on_loss,ends_at,policy_revision,created_by)
  values(p_tenant_id,nullif(p_experiment->>'decision_id','')::uuid,p_experiment->>'name',p_experiment->>'hypothesis',
    p_experiment->>'platform',p_experiment->>'account_id',p_experiment->>'object_id',p_experiment->>'level',v_amount,
    p_experiment->'baseline',(p_experiment->>'stop_on_loss')::boolean,(p_experiment->>'ends_at')::timestamptz,p.revision,p_actor) returning id into v_id;
  return jsonb_build_object('status','created','id',v_id);
end $$;

drop function public.record_growth_experiment_check(uuid, uuid, jsonb);
create function public.record_growth_experiment_check(p_tenant_id uuid,p_id uuid,p_check jsonb)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v growth_experiment_controls%rowtype; v_water jsonb; v_spent numeric; v_state text := p_check->>'state';
begin
  select * into v from growth_experiment_controls where tenant_id=p_tenant_id and id=p_id for update;
  if not found then return 'missing'; end if;
  if p_check ? 'expected_checked_at' and v.checked_at is distinct from (p_check->>'expected_checked_at')::timestamptz then return 'conflict'; end if;
  if v.state = 'founder_resumed' then return 'terminal'; end if;
  if v_state is null or v_state not in ('monitoring','stopping','stop_failed','stopped','needs_attention','object_gone') then
    raise exception 'Invalid experiment state' using errcode='22023'; end if;
  if (p_check->>'spent_usd')::numeric is null or (p_check->>'spent_usd')::numeric<0
    or (p_check->>'exposure_usd')::numeric is null or (p_check->>'exposure_usd')::numeric<0
    or exists (select 1 from jsonb_each(coalesce(p_check->'spend_highwater','{}'::jsonb)) e where jsonb_typeof(e.value)<>'number' or (e.value#>>'{}')::numeric<0) then
    raise exception 'Invalid experiment reading' using errcode='22023'; end if;
  select coalesce(jsonb_object_agg(k,n),'{}'::jsonb) into v_water from (
    select key k,max(value::numeric) n from (
      select * from jsonb_each_text(v.spend_highwater) union all
      select * from jsonb_each_text(coalesce(p_check->'spend_highwater','{}'::jsonb))
    ) readings group by key
  ) merged;
  select greatest(v.spent_usd,(p_check->>'spent_usd')::numeric,coalesce(sum(value::numeric),0)) into v_spent from jsonb_each_text(v_water);
  update growth_experiment_controls set
    spend_highwater=v_water,spent_usd=v_spent,
    exposure_usd=greatest(v_spent,(p_check->>'exposure_usd')::numeric),
    state=case when state in ('stopped','object_gone') then state
               when state in ('stopping','stop_failed') and v_state='monitoring' then state else v_state end,
    reason=left(p_check->>'reason',500),checked_at=now(),
    pause_action_id=coalesce(nullif(p_check->>'pause_action_id','')::uuid,pause_action_id),
    failing_since=case when v_state in ('needs_attention','stop_failed') then coalesce(failing_since, nullif(p_check->>'failing_since','')::timestamptz, now())
                       else null end,
    stop_requested_at=case when (p_check->>'stop')::boolean then coalesce(stop_requested_at,now()) else stop_requested_at end,
    stopped_at=case when v_state in ('stopped','object_gone') then coalesce(stopped_at,now()) else stopped_at end
  where tenant_id=p_tenant_id and id=p_id;
  return case when v.state in ('stopped','object_gone') then 'terminal' else 'applied' end;
end $$;

revoke all on function public.register_growth_experiment(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.record_growth_experiment_check(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.register_growth_experiment(uuid,uuid,jsonb) to service_role;
grant execute on function public.record_growth_experiment_check(uuid,uuid,jsonb) to service_role;
commit;
