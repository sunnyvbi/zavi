create table public.growth_strategy_generation (
 tenant_id uuid primary key references public.tenants(id) on delete cascade,
 generation bigint not null default 0,
 reset_at timestamptz
);
create table public.growth_strategy_delivery (
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 run_id uuid primary key references public.agent_runs(id) on delete cascade,
 generation bigint not null,
 phase text not null check (phase in ('writing','checking','saving','applied','failed','superseded')),
 artifact jsonb,
 plan_id uuid,
 goal_id uuid,
 phase_times jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now()
);
create index growth_strategy_delivery_tenant on public.growth_strategy_delivery(tenant_id, updated_at desc);
alter table public.growth_strategy_generation enable row level security;
alter table public.growth_strategy_delivery enable row level security;
revoke all on public.growth_strategy_generation, public.growth_strategy_delivery from anon, authenticated;
grant select on public.growth_strategy_delivery to authenticated;
grant all on public.growth_strategy_generation, public.growth_strategy_delivery to service_role;
create policy growth_strategy_delivery_read on public.growth_strategy_delivery for select to authenticated
 using (tenant_id in (select tu.tenant_id from public.tenant_users tu where tu.user_id = auth.uid()));

create function public.advance_growth_strategy(p_tenant_id uuid, p_run_id uuid, p_phase text, p_artifact jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
 r agent_runs%rowtype;
 g growth_strategy_generation%rowtype;
 d growth_strategy_delivery%rowtype;
 n memory_note%rowtype;
 s jsonb;
 a jsonb;
 advance_goal_id uuid;
 goal_issue text;
 v_plan_id uuid;
 result jsonb;
 bets jsonb;
 stamp timestamptz;
begin
 perform 1 from tenants where id=p_tenant_id for update;
 if not found then raise exception 'strategy tenant missing'; end if;
 select * into r from agent_runs where id=p_run_id and tenant_id=p_tenant_id and agent_slug='cgo';
 if not found or r.payload->>'stage' is distinct from 'draft_strategy' then raise exception 'strategy run not found'; end if;
 if p_phase not in ('writing','checking','saving','failed','apply') then raise exception 'invalid strategy phase'; end if;
 insert into growth_strategy_generation(tenant_id) values(p_tenant_id) on conflict do nothing;
 select * into g from growth_strategy_generation where tenant_id=p_tenant_id;
 select * into n from memory_note where tenant_id=p_tenant_id and note_type='growth_strategy'
   and tags @> array['current-growth-strategy']::text[] and superseded_by is null order by updated_at desc limit 1;
 stamp := greatest(g.reset_at, (n.metadata->>'reset_at')::timestamptz);
 select * into d from growth_strategy_delivery where run_id=p_run_id and tenant_id=p_tenant_id;
 if r.enqueued_at <= stamp or (d.run_id is not null and d.generation<>g.generation)
    or exists(select 1 from growth_strategy_delivery x join agent_runs newer on newer.id=x.run_id
      where x.tenant_id=p_tenant_id and x.phase='applied' and newer.enqueued_at>r.enqueued_at)
    or (d.phase is distinct from 'applied' and (
      exists(select 1 from growth_plan p where p.tenant_id=p_tenant_id and p.status='live' and p.created_at>r.enqueued_at)
      or (n.metadata->>'accepted'='true' and n.source='agent_run' and exists(select 1 from agent_runs newer
        where newer.tenant_id=p_tenant_id and newer.id::text=n.source_ref and newer.enqueued_at>r.enqueued_at)))) then
   insert into growth_strategy_delivery(tenant_id,run_id,generation,phase) values(p_tenant_id,p_run_id,g.generation,'superseded')
   on conflict(run_id) do update set phase='superseded',updated_at=now()
     where growth_strategy_delivery.tenant_id=p_tenant_id and growth_strategy_delivery.phase<>'applied';
   return jsonb_build_object('phase','superseded');
 end if;
 if d.phase='applied' then
   if not exists(select 1 from growth_plan where tenant_id=p_tenant_id and id=d.plan_id and status='live') then
     return jsonb_build_object('phase','superseded');
   end if;
   return jsonb_build_object('phase','applied','plan_id',d.plan_id,'goal_id',d.goal_id);
 end if;
 if p_phase<>'apply' then
   insert into growth_strategy_delivery(tenant_id,run_id,generation,phase,artifact,phase_times)
   values(p_tenant_id,p_run_id,g.generation,p_phase,p_artifact,jsonb_build_object(p_phase,clock_timestamp()))
   on conflict(run_id) do update set phase=excluded.phase,
     artifact=coalesce(growth_strategy_delivery.artifact,excluded.artifact),
     phase_times=excluded.phase_times || growth_strategy_delivery.phase_times,updated_at=now();
   return jsonb_build_object('phase',p_phase);
 end if;
 a:=d.artifact;
 s:=a->'strategy';
 if s is null or jsonb_typeof(s)<>'object' then raise exception 'strategy draft missing'; end if;
 select jsonb_agg(b || '{"autorun":false}'::jsonb) into bets from jsonb_array_elements(s->'channel_bets') b;
 begin
 if n.metadata->>'applied_spine'=a->>'spine' then
   select id into advance_goal_id from autopilot_goals where tenant_id=p_tenant_id and id=(n.metadata->>'applied_goal_id')::uuid and status='active';
 end if;
 if advance_goal_id is null and s->'goal' is not null and s->'goal'<>'null'::jsonb then
   select id into advance_goal_id from autopilot_goals where tenant_id=p_tenant_id and status='active'
     and objective=s->'goal'->>'objective' and target_metric=s->'goal'->>'target_metric' limit 1;
   if advance_goal_id is null then
     if (select count(*) from autopilot_goals where tenant_id=p_tenant_id and status='active') >= (a->>'goal_limit')::int then
       goal_issue:='limit_reached';
       raise exception 'strategy_goal_limit_reached';
     end if;
     result:=write_autopilot_goal(p_tenant_id,'insert',null,
       jsonb_build_object('objective',s->'goal'->>'objective','target_metric',s->'goal'->>'target_metric',
       'target_value',s->'goal'->'target_value','baseline_value',null,'current_value',null,
       'due_date',s->'goal'->>'due_date','priority',50,'source','founder','measurement_mode',a->>'measurement_mode'),null,null,'cgo',null,p_run_id,'Applied the growth strategy');
     if result->>'status' is distinct from 'written' then raise exception 'strategy goal not saved'; end if;
     advance_goal_id:=(result->>'id')::uuid;
   end if;
 end if;
 exception when others then
   advance_goal_id:=null;
   goal_issue:=coalesce(goal_issue,'write_failed');
 end;
 perform memory_note_upsert_anchor(p_tenant_id,'metrics_north_star','Metrics / North Star',a->>'north_star_anchor','agent_write','{}'::jsonb);
 perform memory_note_upsert_anchor(p_tenant_id,'gtm_growth','GTM / Growth',a->>'gtm_anchor','agent_write','{}'::jsonb);
 update memory_note set enrichment_state='pending',content_hash=null where tenant_id=p_tenant_id and slug in ('metrics_north_star','gtm_growth') and superseded_by is null;
 if n.metadata->>'applied_fingerprint'=a->>'fingerprint' and n.metadata->>'accepted'='true' then
   select id into v_plan_id from growth_plan where tenant_id=p_tenant_id and status='live' and id=(n.metadata->>'applied_plan_id')::uuid;
 end if;
 if v_plan_id is null then
 v_plan_id:=commit_growth_plan(p_tenant_id,coalesce(s->'goal'->>'objective',s->'constraint'->>'statement'),
   s->'north_star'->>'metric',s->'constraint'->>'statement',s->'constraint'->>'confidence',bets,
   coalesce(s->'basis_evidence','[]'::jsonb),'agent','cgo');
 if v_plan_id is null then raise exception 'strategy plan not saved'; end if;
 update tenant_channels set cgo_reason=null,cgo_set_at=null,cgo_run_id=null where tenant_id=p_tenant_id and cgo_reason is not null;
 update cgo_hypotheses set restates_plan_constraint=false where tenant_id=p_tenant_id and restates_plan_constraint=true;
 end if;
 if n.id is null then
   insert into memory_note(tenant_id,note_type,title,body_markdown,source,source_ref,tags,metadata)
   values(p_tenant_id,'growth_strategy',a->>'title',a->>'body','agent_run',p_run_id::text,
     array['current-growth-strategy'], '{}') returning * into n;
 end if;
 update memory_note set tags=array['current-growth-strategy','confidence:' || (s->'constraint'->>'confidence')], title=a->>'title',body_markdown=a->>'body',source='agent_run',source_ref=p_run_id::text,
   metadata=coalesce(n.metadata,'{}') || jsonb_build_object('kind','growth_strategy','strategy',s,'accepted',true,
     'applied_fingerprint',a->>'fingerprint','applied_spine',a->>'spine','applied_goal_id',advance_goal_id,
     'applied_run_id',p_run_id,'applied_plan_id',v_plan_id,'generation',g.generation,'goal_save_issue',goal_issue),
   enrichment_state='pending',content_hash=null,updated_at=now() where id=n.id and tenant_id=p_tenant_id;
 delete from memory_chunk where tenant_id=p_tenant_id and note_id=n.id;
 update growth_strategy_delivery set phase='applied',plan_id=v_plan_id,goal_id=advance_goal_id,phase_times=phase_times || jsonb_build_object('applied',clock_timestamp()),updated_at=now() where run_id=p_run_id and tenant_id=p_tenant_id;
 return jsonb_build_object('phase','applied','plan_id',v_plan_id,'goal_id',advance_goal_id);
end $$;
revoke all on function public.advance_growth_strategy(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.advance_growth_strategy(uuid,uuid,text,jsonb) to service_role;

create function public.reset_growth_strategy_delivery(p_tenant_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n uuid; retired int; stamp timestamptz:=clock_timestamp();
begin
 perform 1 from tenants where id=p_tenant_id for update;
 if not found then raise exception 'strategy tenant missing'; end if;
 insert into growth_strategy_generation(tenant_id,generation,reset_at) values(p_tenant_id,1,stamp)
 on conflict(tenant_id) do update set generation=growth_strategy_generation.generation+1,reset_at=excluded.reset_at;
 update growth_strategy_delivery set phase='superseded',updated_at=now() where tenant_id=p_tenant_id and phase<>'superseded';
 for n in select id from memory_note where tenant_id=p_tenant_id and note_type='growth_strategy'
   and tags @> array['current-growth-strategy']::text[] and superseded_by is null
 loop
   update memory_note set metadata=(coalesce(metadata,'{}'::jsonb) - array['strategy','applied_fingerprint','applied_spine','applied_goal_id','applied_run_id','applied_plan_id','generation','goal_save_issue']::text[])
       || jsonb_build_object('kind','growth_strategy','accepted',false,'interview','{}'::jsonb,'reset_at',stamp),
     tags=array['current-growth-strategy'],
     title='Growth strategy — in progress',body_markdown='_Interview in progress._',source='human',source_ref=null,
     content_hash=null,enrichment_state='pending',updated_at=now() where id=n and tenant_id=p_tenant_id;
   delete from memory_chunk where tenant_id=p_tenant_id and note_id=n;
 end loop;
 if n is null then
   insert into memory_note(tenant_id,note_type,title,body_markdown,source,tags,metadata)
   values(p_tenant_id,'growth_strategy','Growth strategy — in progress','_Interview in progress._','human',array['current-growth-strategy'],
    jsonb_build_object('kind','growth_strategy','accepted',false,'interview','{}'::jsonb,'reset_at',stamp));
 end if;
 retired:=retire_growth_plan(p_tenant_id);
 update tenant_channels set cgo_reason=null,cgo_set_at=null,cgo_run_id=null where tenant_id=p_tenant_id and cgo_reason is not null;
 return jsonb_build_object('ok',true,'plan_retired',retired);
end $$;
revoke all on function public.reset_growth_strategy_delivery(uuid) from public,anon,authenticated;
grant execute on function public.reset_growth_strategy_delivery(uuid) to service_role;
