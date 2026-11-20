
do $$
declare c text;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'autopilot_goals'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%status%'
  loop
    execute format('alter table autopilot_goals drop constraint %I', c);
  end loop;
end $$;

alter table autopilot_goals
  add constraint autopilot_goals_status_check
  check (status in ('active','met','missed','paused','proposed'));

create or replace function propose_autopilot_goal(
  p_tenant_id     uuid,
  p_objective     text,
  p_target_metric text,
  p_target_value  numeric,
  p_rationale     text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_tenant_id is null or p_objective is null or p_target_metric is null
     or p_target_value is null then
    raise exception 'propose_autopilot_goal: tenant_id/objective/target_metric/target_value required'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from autopilot_goals
    where tenant_id = p_tenant_id and status = 'active' and source = 'founder'
  ) then
    return null;
  end if;

  update autopilot_goals
     set status = 'missed'
   where tenant_id = p_tenant_id and status = 'proposed';

  insert into autopilot_goals (
    tenant_id, objective, target_metric, target_value, baseline_value,
    current_value, priority, source, status, metadata
  ) values (
    p_tenant_id, p_objective, p_target_metric, p_target_value, null,
    null, 50, 'agent_proposed', 'proposed',
    jsonb_build_object('proposed_by', 'goal-proposer',
                       'rationale', coalesce(p_rationale, ''))
  ) returning id into v_id;
  return v_id;
end $$;

revoke all on function propose_autopilot_goal(uuid, text, text, numeric, text) from public, anon, authenticated;
grant execute on function propose_autopilot_goal(uuid, text, text, numeric, text) to service_role;

create or replace function confirm_proposed_goal(p_goal_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_tenant uuid; v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'auth required' using errcode = '42501'; end if;

  select tenant_id into v_tenant from autopilot_goals
   where id = p_goal_id and status = 'proposed';
  if v_tenant is null then
    raise exception 'no proposed goal %', p_goal_id using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from tenant_users where tenant_id = v_tenant and user_id = v_uid
  ) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;

  update autopilot_goals
     set status = 'active', source = 'founder'
   where id = p_goal_id;
  return p_goal_id;
end $$;

revoke all on function confirm_proposed_goal(uuid) from public, anon;
grant execute on function confirm_proposed_goal(uuid) to authenticated, service_role;

create or replace function compute_tenant_readiness(p_tenant_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shape text; v_url jsonb;
  v_brain int := 0; v_url_pts int := 0; v_conn int := 0;
  v_goal int := 0; v_deliv int := 0; v_founder int := 0;
  v_matched int := 0;
  v_req text[]; v_reqcount int; v_metreq int := 0; v_cats text[];
  v_dcount int; v_m7 int; v_m21 int; v_mever int;
  v_last_disc timestamptz;
  v_score int; v_dims jsonb;
begin
  if p_tenant_id is null then
    raise exception 'p_tenant_id required' using errcode = '22023';
  end if;

  select company_shape, product_url into v_shape, v_url from tenants where id = p_tenant_id;
  if not found then
    raise exception 'tenant % not found', p_tenant_id using errcode = 'P0002';
  end if;

  select count(*) into v_matched
  from memory_note n
  where n.tenant_id = p_tenant_id
    and n.note_type = 'anchor'
    and n.superseded_by is null
    and n.slug in ('company','ops','policies','disputes','support')
    and n.source in ('human','agent_discovery_verified','praxis_staff')
    and length(btrim(n.body_markdown)) > 40
    and left(n.body_markdown, 150) !~*
        '(set this up|we haven''t (written|finalized|published|defined)|operator to (define|fill|set|confirm)|to be confirmed)';
  v_brain := round(20.0 * least(v_matched, 5) / 5.0);

  if v_url is not null and exists (
    select 1 from jsonb_each_text(v_url) e(k, v)
    where e.k in ('marketing','api') and btrim(e.v) <> '' and left(e.v, 8) = 'https://'
  ) then v_url_pts := 10; end if;

  v_req := case coalesce(v_shape, 'other')
             when 'services' then array['comms','data']
             else array['payments','data','comms'] end;
  v_reqcount := array_length(v_req, 1);
  select coalesce(array_agg(distinct cat) filter (where cat is not null), array[]::text[])
    into v_cats
  from (
    select case s.server_id
             when 'stripe'      then 'payments'
             when 'mongo'       then 'data'
             when 'operator_db' then 'data'
             when 'operator-db' then 'data'
             when 'slack'       then 'comms'
             when 'gmail'       then 'comms'
             else null
           end as cat
    from tenant_mcp_servers s
    where s.tenant_id = p_tenant_id and s.enabled
  ) q;
  select count(*) into v_metreq from unnest(v_req) r where r = any(v_cats);
  v_conn := round(30.0 * v_metreq / greatest(v_reqcount, 1));

  if exists (select 1 from autopilot_goals g
             where g.tenant_id = p_tenant_id and g.status = 'active' and g.measurement_mode = 'auto') then
    v_goal := 15;
  elsif exists (select 1 from autopilot_goals g
                where g.tenant_id = p_tenant_id and g.status = 'active') then
    v_goal := 7;
  elsif exists (select 1 from autopilot_goals g
                where g.tenant_id = p_tenant_id and g.status = 'proposed') then
    v_goal := 5;
  end if;

  select count(*) into v_dcount from agent_runs r
  where r.tenant_id = p_tenant_id
    and r.status = 'success' and coalesce(r.parse_ok, false)
    and coalesce(r.finished_at, r.enqueued_at) >= now() - interval '30 days';
  v_deliv := case when v_dcount >= 3 then 15 when v_dcount >= 1 then 8 else 0 end;

  select
    count(*) filter (where created_at >= now() - interval '7 days'),
    count(*) filter (where created_at >= now() - interval '21 days'),
    count(*)
  into v_m7, v_m21, v_mever
  from agent_thread_messages m
  where m.tenant_id = p_tenant_id and m.sender_role = 'user';
  v_founder := case when v_m7 > 0 then 10 when v_m21 > 0 then 6 when v_mever > 0 then 3 else 0 end;

  v_score := v_brain + v_url_pts + v_conn + v_goal + v_deliv + v_founder;
  v_dims := jsonb_build_object(
    'verified_brain',   v_brain,
    'product_url',      v_url_pts,
    'connectors',       v_conn,
    'goal_measurable',  v_goal,
    'deliverable',      v_deliv,
    'founder_engaged',  v_founder,
    'brain_anchors_matched', v_matched,
    'connectors_required',   to_jsonb(v_req),
    'connectors_met',        v_metreq
  );

  select max(created_at) into v_last_disc from memory_note
  where tenant_id = p_tenant_id
    and source in ('agent_discovery_verified','agent_discovery_inferred');

  insert into tenant_readiness (tenant_id, score, dimensions, computed_at, last_discovery_at)
  values (p_tenant_id, v_score, v_dims, now(), v_last_disc)
  on conflict (tenant_id) do update
    set score = excluded.score, dimensions = excluded.dimensions, computed_at = now(),
        last_discovery_at = coalesce(excluded.last_discovery_at, tenant_readiness.last_discovery_at);

  return v_score;
end $$;

revoke execute on function compute_tenant_readiness(uuid) from public, anon, authenticated;
grant execute on function compute_tenant_readiness(uuid) to service_role;
