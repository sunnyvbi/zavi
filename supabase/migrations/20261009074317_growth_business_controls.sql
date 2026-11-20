begin;

create table public.growth_business_policies (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  policy jsonb not null,
  revision bigint not null default 1,
  updated_by uuid not null,
  updated_at timestamptz not null default now()
);
create table public.growth_experiment_controls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  decision_id uuid,
  name text not null check (length(name) between 1 and 160),
  hypothesis text not null check (length(hypothesis) between 1 and 500),
  platform text not null check (platform in ('meta','google','chatgpt')),
  account_id text not null,
  object_id text not null,
  level text not null check (level in ('campaign','ad_set')),
  budget_usd numeric(12,2) not null check (budget_usd > 0),
  baseline jsonb not null,
  stop_on_loss boolean not null default false,
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  policy_revision bigint not null,
  spend_highwater jsonb not null default '{}',
  spent_usd numeric(12,2) not null default 0 check (spent_usd >= 0),
  exposure_usd numeric(12,2) not null default 0 check (exposure_usd >= 0),
  state text not null default 'monitoring' check (state in ('monitoring','stopping','stop_failed','stopped','needs_attention')),
  reason text,
  pause_action_id uuid,
  checked_at timestamptz,
  stopped_at timestamptz,
  stop_requested_at timestamptz,
  created_by uuid,
  unique (tenant_id, decision_id, platform, account_id, object_id),
  check (ends_at > started_at and ends_at <= started_at + interval '30 days')
);
create unique index growth_experiment_active_object on public.growth_experiment_controls
  (tenant_id, platform, account_id, object_id) where stopped_at is null;
create index growth_experiment_tenant_state on public.growth_experiment_controls(tenant_id, state);

alter table public.growth_business_policies enable row level security;
alter table public.growth_experiment_controls enable row level security;
revoke all on public.growth_business_policies, public.growth_experiment_controls from public, anon, authenticated;
grant select on public.growth_business_policies, public.growth_experiment_controls to service_role;

create function public.save_growth_business_policy(p_tenant_id uuid, p_actor uuid, p_policy jsonb, p_revision bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_revision bigint;
begin
  perform _ad_budget_assert_manager(p_tenant_id, p_actor);
  if (p_policy->>'enabled')::boolean and _tenant_tier(p_tenant_id) <> 'pro' then raise exception 'Pro plan required' using errcode='22023'; end if;
  perform 1 from tenants where id=p_tenant_id for update;
  select revision into v_revision from growth_business_policies where tenant_id=p_tenant_id;
  if coalesce(v_revision,0) <> p_revision then return jsonb_build_object('status','conflict'); end if;
  if p_policy is null or p_revision is null or
    exists (select 1 from jsonb_each(p_policy) e where e.value = 'null'::jsonb)
    or (select count(*) from jsonb_object_keys(p_policy)) <> 11
    or exists (select 1 from jsonb_each(p_policy) e where e.key not in ('enabled','automatic_stops','metric') and jsonb_typeof(e.value) <> 'number')
    or exists (select 1 from jsonb_each(p_policy) e where e.key in ('min_results','min_age_days','step_percent','reporting_delay_hours') and (e.value#>>'{}')::numeric <> trunc((e.value#>>'{}')::numeric))
    or jsonb_typeof(p_policy) <> 'object'
    or jsonb_typeof(p_policy->'enabled') <> 'boolean'
    or jsonb_typeof(p_policy->'automatic_stops') <> 'boolean'
    or not (p_policy->>'metric' in ('cpa','roas'))
    or not ((p_policy->>'max_cpa_usd')::numeric > 0 and (p_policy->>'max_cpa_usd')::numeric <= 1000000)
    or not ((p_policy->>'min_roas')::numeric > 0 and (p_policy->>'min_roas')::numeric <= 1000)
    or not ((p_policy->>'min_results')::integer between 1 and 10000)
    or not ((p_policy->>'min_spend_usd')::numeric > 0 and (p_policy->>'min_spend_usd')::numeric <= 1000000)
    or not ((p_policy->>'min_age_days')::integer between 1 and 90)
    or not ((p_policy->>'exploration_percent')::numeric between 0 and 100)
    or not ((p_policy->>'step_percent')::integer between 1 and 100)
    or not ((p_policy->>'reporting_delay_hours')::integer between 1 and 72)
    or not (p_policy ?& array['enabled','automatic_stops','metric','max_cpa_usd','min_roas','min_results','min_spend_usd','min_age_days','exploration_percent','step_percent','reporting_delay_hours'])
  then raise exception 'Invalid business controls' using errcode='22023'; end if;
  insert into growth_business_policies(tenant_id,policy,updated_by)
    values(p_tenant_id,p_policy,p_actor)
    on conflict(tenant_id) do update set policy=excluded.policy,
      revision=growth_business_policies.revision+1,updated_by=p_actor,updated_at=now()
    returning revision into v_revision;
  return jsonb_build_object('status','saved','revision',v_revision);
end $$;

create function public.register_growth_experiment(p_tenant_id uuid, p_actor uuid, p_experiment jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare p growth_business_policies%rowtype; v_id uuid; v_cap numeric; v_used numeric; v_amount numeric; o ad_campaigns%rowtype; v_decision uuid; v_test jsonb; v_target text;
begin
  if _tenant_tier(p_tenant_id) <> 'pro' then raise exception 'Pro plan required' using errcode='22023'; end if;
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
      and e.platform=o.platform and e.account_id=o.account_id
      and (e.stopped_at is null or e.stopped_at+make_interval(hours=>(p.policy->>'reporting_delay_hours')::int+24)>now())
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
  v_cap := (ad_budget_month_view(p_tenant_id)->>'month_cap_usd')::numeric;
  if v_cap is null or not exists (select 1 from ad_budgets where tenant_id=p_tenant_id and status='active') then raise exception 'Active Growth budget required' using errcode='22023'; end if;
  select coalesce(sum(greatest(budget_usd,spent_usd)),0) into v_used from growth_experiment_controls
    where tenant_id=p_tenant_id and (started_at >= date_trunc('month',now()) or stopped_at is null);
  v_amount := (p_experiment->>'budget_usd')::numeric;
  if v_decision is not null then
    select body->'test',body->>'target_agent_slug' into v_test,v_target from decisions where tenant_id=p_tenant_id and id=v_decision;
    if (v_test ? 'stop_if' and not (v_test ? 'stop_rule'))
      or (p_experiment->>'stop_on_loss')::boolean is distinct from coalesce(v_test->>'stop_rule'='business_loss',false)
      or (v_test->>'budget_usd')::numeric is null or v_amount+(select coalesce(sum(greatest(budget_usd,spent_usd)),0) from growth_experiment_controls where tenant_id=p_tenant_id and decision_id=v_decision) > (v_test->>'budget_usd')::numeric
      or (p_experiment->>'ends_at')::timestamptz > ((v_test->>'readout_on')::date+1)::timestamptz
      or v_target is null or not (case p_experiment->>'platform' when 'meta' then v_target='meta_ads' when 'google' then v_target in ('google_ads','youtube_ads') when 'chatgpt' then v_target='chatgpt_ads' else false end) then
      raise exception 'Experiment exceeds its CGO source budget, channel or deadline' using errcode='22023';
    end if;
  end if;
  if v_amount is null or v_amount <= o.budget_usd*2*((p.policy->>'reporting_delay_hours')::numeric+1)/24 or v_amount + v_used > v_cap*(p.policy->>'exploration_percent')::numeric/100 then
    raise exception 'Experiment exceeds the remaining exploration allowance' using errcode='22023';
  end if;
  insert into growth_experiment_controls(tenant_id,decision_id,name,hypothesis,platform,account_id,object_id,level,
    budget_usd,baseline,stop_on_loss,ends_at,policy_revision,created_by)
  values(p_tenant_id,nullif(p_experiment->>'decision_id','')::uuid,p_experiment->>'name',p_experiment->>'hypothesis',
    p_experiment->>'platform',p_experiment->>'account_id',p_experiment->>'object_id',p_experiment->>'level',v_amount,
    p_experiment->'baseline',(p_experiment->>'stop_on_loss')::boolean,(p_experiment->>'ends_at')::timestamptz,p.revision,p_actor) returning id into v_id;
  return jsonb_build_object('status','created','id',v_id);
end $$;

create function public.record_growth_experiment_check(p_tenant_id uuid,p_id uuid,p_check jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v growth_experiment_controls%rowtype; v_water jsonb; v_spent numeric;
begin
  select * into v from growth_experiment_controls where tenant_id=p_tenant_id and id=p_id for update;
  if not found then return; end if;
  if p_check ? 'expected_checked_at' and v.checked_at is distinct from (p_check->>'expected_checked_at')::timestamptz then return; end if;
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
    state=case when state='stopped' then 'stopped' when state in ('stopping','stop_failed') and p_check->>'state'='monitoring' then state else p_check->>'state' end,
    reason=left(p_check->>'reason',500),checked_at=now(),
    pause_action_id=coalesce(nullif(p_check->>'pause_action_id','')::uuid,pause_action_id),
    stop_requested_at=case when (p_check->>'stop')::boolean then coalesce(stop_requested_at,now()) else stop_requested_at end,
    stopped_at=case when p_check->>'state'='stopped' then coalesce(stopped_at,now()) else stopped_at end
  where tenant_id=p_tenant_id and id=p_id;
end $$;

revoke all on function public.save_growth_business_policy(uuid,uuid,jsonb,bigint) from public,anon,authenticated;
revoke all on function public.register_growth_experiment(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.record_growth_experiment_check(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.save_growth_business_policy(uuid,uuid,jsonb,bigint) to service_role;
grant execute on function public.register_growth_experiment(uuid,uuid,jsonb) to service_role;
grant execute on function public.record_growth_experiment_check(uuid,uuid,jsonb) to service_role;
commit;
