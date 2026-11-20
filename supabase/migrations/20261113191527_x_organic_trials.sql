create table public.x_organic_trials (
  action_id uuid primary key references public.channel_actions(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  run_id uuid not null references public.agent_runs(id),
  created_at timestamptz not null default now(),
  next_check_at timestamptz not null default now(),
  phase text not null default 'awaiting_posts' check (phase in ('awaiting_posts','observing','waiting_metrics','waiting_budget','waiting_connection','no_replies','proposed','cancelled','expired')),
  receipts jsonb not null default '[]',
  proposal jsonb,
  result_action_id uuid references public.channel_actions(id),
  budget_action_id uuid references public.channel_actions(id),
  connection_action_id uuid references public.channel_actions(id),
  final_action_id uuid references public.channel_actions(id),
  note text not null default 'Publish all three posts. Zavi will compare replies after every post has been live for three days.'
);
alter table public.x_organic_trials enable row level security;
revoke all on public.x_organic_trials from public, anon, authenticated;
grant select on public.x_organic_trials to service_role;
create index x_organic_trials_due on public.x_organic_trials(next_check_at) where phase not in ('no_replies','proposed','cancelled','expired');

create unique index channel_x_organic_trial_result_once
  on public.channel_actions(tenant_id,(exec_payload->>'organic_trial_id'))
  where channel_slug='x_ads' and exec_class='x_ads.create_campaign'
    and exec_payload->>'origin'='x_organic_trial'
    and exec_payload->>'organic_trial_id' is not null;

create function public.register_x_organic_trial() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.channel_slug='x_ads' and new.exec_class is null
    and new.body #>> '{step,deliverable,kind}'='post'
    and new.body #>> '{step,deliverable,presentation,type}'='x_organic_trial'
    and (case when jsonb_typeof(new.body #> '{step,deliverable,parts}')='array'
      then jsonb_array_length(new.body #> '{step,deliverable,parts}')=3 else false end)
    and exists(select 1 from public.agent_runs r where r.id=new.run_id and r.tenant_id=new.tenant_id and r.channel_slug='x_ads') then
    insert into public.x_organic_trials(action_id,tenant_id,run_id) values(new.id,new.tenant_id,new.run_id) on conflict do nothing;
  end if;
  return new;
end $$;
revoke all on function public.register_x_organic_trial() from public,anon,authenticated;
create trigger channel_x_organic_trial after insert on public.channel_actions for each row execute function public.register_x_organic_trial();

create function public.update_x_organic_trial(p_tenant_id uuid,p_action_id uuid,p_phase text,p_note text,
  p_receipts jsonb default null,p_proposal jsonb default null,p_result_action_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_trial public.x_organic_trials%rowtype;
  v_card jsonb;
  v_written jsonb;
  v_outcome_id uuid;
  v_position int;
  v_title text;
  v_label text;
  v_link text;
  v_kind text;
begin
  if p_phase is null or p_phase not in ('awaiting_posts','observing','waiting_metrics','waiting_budget','waiting_connection','no_replies','proposed','cancelled','expired') then
    raise exception 'invalid trial phase';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('channel_card:' || p_tenant_id || ':x_ads', 0));
  select * into v_trial from public.x_organic_trials
    where action_id=p_action_id and tenant_id=p_tenant_id for update;
  if not found then raise exception 'trial not found'; end if;
  if v_trial.phase in ('no_replies','proposed','cancelled','expired') then return to_jsonb(v_trial); end if;
  if p_receipts is not null and jsonb_typeof(p_receipts) is distinct from 'array' then raise exception 'invalid trial receipts'; end if;
  if p_proposal is not null and jsonb_typeof(p_proposal) is distinct from 'object' then raise exception 'invalid trial proposal'; end if;
  if p_result_action_id is not null and not exists (
    select 1 from public.channel_actions a where a.id=p_result_action_id and a.tenant_id=p_tenant_id
      and a.run_id=v_trial.run_id and a.channel_slug='x_ads' and a.exec_class='x_ads.create_campaign'
      and a.exec_payload->>'organic_trial_id'=p_action_id::text
      and a.exec_payload->>'origin'='x_organic_trial'
  ) then raise exception 'foreign or mismatched trial result'; end if;
  if p_phase='proposed' and (v_trial.proposal is null or p_result_action_id is null) then
    raise exception 'trial proposal and result required';
  end if;
  if v_trial.proposal is not null and p_phase not in ('proposed','cancelled','expired') then
    update public.x_organic_trials set next_check_at=now()+interval '24 hours'
      where action_id=p_action_id and tenant_id=p_tenant_id returning * into v_trial;
    return to_jsonb(v_trial);
  end if;

  if (p_phase='waiting_budget' and v_trial.budget_action_id is null)
    or (p_phase='waiting_connection' and v_trial.connection_action_id is null)
    or (p_phase in ('no_replies','expired') and v_trial.final_action_id is null) then
    v_kind := case when p_phase='waiting_budget' then 'budget' when p_phase='waiting_connection' then 'connection' else 'result' end;
    v_title := case when p_phase='waiting_budget' then 'Review the budget for your winning X post'
      when p_phase='waiting_connection' then 'Review X Ads availability for your organic test'
      when p_phase='expired' then 'Start a new X organic test'
      else 'Try a new angle before promoting an X post' end;
    v_label := case when p_phase='waiting_budget' then 'Review ad budget'
      when p_phase='waiting_connection' then 'Review X Ads' else 'Review next posts' end;
    v_link := '/workspace?company=' || p_tenant_id::text || case when p_phase='waiting_budget'
      then '&tab=growth-strategy#ad-budget' when p_phase='waiting_connection' then '&tab=channels&channel=x_ads'
      else '&tab=channels&channel=x_organic' end;
    select greatest(coalesce(max(position),20)+1,21) into v_position from public.channel_actions
      where run_id=v_trial.run_id and position between 21 and 899;
    if v_position>899 then raise exception 'trial outcome positions exhausted'; end if;
    v_card := jsonb_build_object(
      'position',v_position,'run_of',v_position,'action_type','check',
      'title',v_title,'title_key','x-organic-trial:' || p_action_id || ':' || v_kind,
      'target_key','x-organic-trial:' || p_action_id || ':' || v_kind,
      'card_kind','task','primary_label',v_label,'done_label','I reviewed it',
      'how_to',jsonb_build_array(coalesce(left(p_note,1000),''),
        case when p_phase='waiting_budget' then 'Review your saved ad budget. No ad starts without your approval.'
          when p_phase='waiting_connection' then 'Review your plan and connected X Ads account. No ad has been proposed.'
          when p_phase='expired' then 'Start a new organic test. Zavi could not complete this one within its 30-day observation window.'
          else 'Review your organic posts and try a different question or angle. These posts will not be promoted.' end),
      'body',jsonb_build_object('intent','review','owner','founder','link',v_link,
        'organic_trial_id',p_action_id,'trial_outcome',v_kind,
        'step',jsonb_build_object('title',v_title,'body',coalesce(left(p_note,1000),''),
          'intent','review','owner','founder','link',v_link,'effort','minutes','blocking',false)));
    v_written := public.record_channel_run_actions(p_tenant_id,v_trial.run_id,jsonb_build_array(v_card),'[]'::jsonb,'[]'::jsonb);
    v_outcome_id := (v_written #>> '{ids,0,id}')::uuid;
    if v_outcome_id is null or not exists(select 1 from public.channel_actions a
      where a.id=v_outcome_id and a.tenant_id=p_tenant_id and a.run_id=v_trial.run_id
        and a.channel_slug='x_ads' and a.position=v_position and a.exec_class is null) then
      raise exception 'trial outcome card was not filed';
    end if;
  end if;
  update public.x_organic_trials set phase=p_phase,note=coalesce(left(p_note,1000),note),
    receipts=coalesce(p_receipts,receipts),proposal=coalesce(proposal,p_proposal),
    result_action_id=coalesce(result_action_id,p_result_action_id),
    budget_action_id=case when p_phase='waiting_budget' then coalesce(budget_action_id,v_outcome_id) else budget_action_id end,
    connection_action_id=case when p_phase='waiting_connection' then coalesce(connection_action_id,v_outcome_id) else connection_action_id end,
    final_action_id=case when p_phase in ('no_replies','expired') then coalesce(final_action_id,v_outcome_id) else final_action_id end,
    next_check_at=now()+interval '24 hours'
  where action_id=p_action_id and tenant_id=p_tenant_id returning * into v_trial;
  return to_jsonb(v_trial);
end $$;
revoke all on function public.update_x_organic_trial(uuid,uuid,text,text,jsonb,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.update_x_organic_trial(uuid,uuid,text,text,jsonb,jsonb,uuid) to service_role;
