begin;

alter table public.sites add column if not exists publish_run_id uuid;

drop function if exists public.site_publish_begin(uuid, uuid, text);
drop function if exists public.site_settle_stopped(uuid, uuid, text, text);
drop function if exists public.site_settle_stopped(uuid, uuid, text, text, bigint);

create or replace function public.site_publish_begin(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_sha       text,
  p_conductor_run_id uuid default null
) returns bigint
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_gen bigint;
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'site_publish_begin: tenant_id and site_id are required' using errcode = '22023';
  end if;
  if p_sha is null or p_sha !~ '^[0-9a-f]{7,40}$' then
    raise exception 'site_publish_begin: invalid sha' using errcode = '22023';
  end if;
  update public.sites s
     set publish_generation = s.publish_generation + 1,
         desired_sha = p_sha,
         publish_run_id = p_conductor_run_id
   where s.id = p_site_id and s.tenant_id = p_tenant_id
     and (s.publish_lease_generation is null or s.publish_lease_until <= now())
  returning s.publish_generation into v_gen;
  if found then
    return v_gen;
  end if;
  if exists (select 1 from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id) then
    return 0;
  end if;
  raise exception 'site_publish_begin: site not found' using errcode = 'P0002';
end $$;

revoke all on function public.site_publish_begin(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.site_publish_begin(uuid, uuid, text, uuid) to service_role;

create or replace function public.site_settle_stopped(
  p_tenant_id  uuid,
  p_site_id    uuid,
  p_to         text,
  p_last_error text,
  p_generation bigint default null,
  p_conductor_run_id uuid default null
) returns public.sites
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row public.sites;
begin
  if p_tenant_id is null or p_site_id is null or p_to is null then
    raise exception 'site_settle_stopped: tenant_id, site_id and to are required' using errcode = '22023';
  end if;
  if p_to not in ('building', 'failed') then
    raise exception 'site_settle_stopped: to must be building or failed' using errcode = '22023';
  end if;
  update public.sites s set
    status     = case when s.live_deploy_id is not null then 'live' else p_to end,
    last_error = left(coalesce(p_last_error, ''), 500),
    updated_at = now()
  where s.id = p_site_id and s.tenant_id = p_tenant_id and s.status in ('building', 'publishing')
    and ((p_conductor_run_id is not null and s.publish_run_id = p_conductor_run_id)
         or (p_generation is not null and s.publish_generation <= p_generation)
         or (p_generation is null and (p_conductor_run_id is null or s.publish_run_id is null)))
  returning * into v_row;
  if not found then
    return null;
  end if;
  return v_row;
end $$;

revoke all on function public.site_settle_stopped(uuid, uuid, text, text, bigint, uuid) from public, anon, authenticated;
grant execute on function public.site_settle_stopped(uuid, uuid, text, text, bigint, uuid) to service_role;

create or replace function cancel_conductor_run(
  p_tenant_id               uuid,
  p_conductor_run_id        uuid,
  p_reason                  text        default 'user_cancel',
  p_require_updated_before  timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prior_status     text;
  v_updated          uuid;
  v_ledger_id        uuid;
  v_stopped_children int := 0;
  v_failure_class    text;
  v_failure_reason   text;
  v_goal_graph       jsonb;
  v_site_id          uuid;
  v_site_gen         bigint;
begin
  v_failure_class := case p_reason
    when 'user_cancel'      then 'user_cancelled'
    when 'stale_slot_reap'  then 'stale_reaped'
    when 'coach_precedence' then 'coach_precedence'
    else 'unknown'
  end;
  v_failure_reason := case v_failure_class
    when 'user_cancelled'   then 'Cancelled from the workspace.'
    when 'stale_reaped'     then 'No progress within the staleness window; the wedged build slot was reclaimed.'
    when 'coach_precedence' then 'Superseded by a newer build.'
    else 'Terminated: ' || coalesce(p_reason, 'reason not supplied')
  end;
  if p_tenant_id is null or p_conductor_run_id is null then
    raise exception 'cancel_conductor_run: tenant_id and conductor_run_id are required'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('build:' || p_tenant_id::text, 0));

  select status into v_prior_status
  from conductor_runs
  where id = p_conductor_run_id
    and tenant_id = p_tenant_id;

  if v_prior_status is null then
    return jsonb_build_object('ok', false, 'reason', 'conductor_run_not_found');
  end if;

  if v_prior_status in ('halted', 'done', 'failed') then
    return jsonb_build_object(
      'ok', true,
      'cancelled', false,
      'prior_status', v_prior_status
    );
  end if;

  update conductor_runs
     set status = 'failed',
         updated_at = now(),
         failure_class  = v_failure_class,
         failure_reason = v_failure_reason
   where id = p_conductor_run_id
     and tenant_id = p_tenant_id
     and status in ('provisioning', 'active')
     and (p_require_updated_before is null or updated_at < p_require_updated_before)
  returning id, goal_graph into v_updated, v_goal_graph;

  if v_updated is null then
    select status into v_prior_status
    from conductor_runs
    where id = p_conductor_run_id
      and tenant_id = p_tenant_id;
    return jsonb_build_object(
      'ok', true,
      'cancelled', false,
      'prior_status', coalesce(v_prior_status, 'unknown')
    );
  end if;

  select id into v_site_id from public.sites
   where tenant_id = p_tenant_id and root_conductor_run_id = p_conductor_run_id;
  if v_site_id is null then
    select (n.node->'payload'->>'site_id')::uuid into v_site_id
      from jsonb_array_elements(case when jsonb_typeof(v_goal_graph) = 'array'
                                    then v_goal_graph else '[]'::jsonb end) with ordinality n(node, ordinal)
     where (n.node->'payload'->>'site_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     order by n.ordinal limit 1;
  end if;
  select max((n.node->'payload'->>'site_publish_generation')::bigint) into v_site_gen
    from jsonb_array_elements(case when jsonb_typeof(v_goal_graph) = 'array'
                                  then v_goal_graph else '[]'::jsonb end) n(node)
   where (n.node->'payload'->>'site_publish_generation') ~ '^[0-9]{1,18}$';
  update public.sites s set
    status = case when s.live_deploy_id is not null then 'live'
                  when s.root_conductor_run_id = p_conductor_run_id then 'failed'
                  else 'building' end,
    last_error = left(v_failure_reason, 500),
    updated_at = now()
   where s.id = v_site_id and s.tenant_id = p_tenant_id
     and s.status in ('provisioning', 'building', 'publishing')
     and (s.publish_run_id = p_conductor_run_id
          or (v_site_gen is not null and s.publish_generation <= v_site_gen)
          or (v_site_gen is null and s.publish_run_id is null));

  with stopped as (
    update agent_runs
       set stop_requested = true
     where tenant_id = p_tenant_id
       and status in ('queued', 'running')
       and id in (
         select dh.target_run_id
         from dispatch_history dh
         where dh.tenant_id = p_tenant_id
           and dh.source_run_id = p_conductor_run_id
           and dh.target_run_id is not null
       )
    returning 1
  )
  select count(*) into v_stopped_children from stopped;

  v_ledger_id := append_autopilot_action(
    p_tenant_id,
    p_conductor_run_id,
    null,
    'undo',
    null,
    null,
    null,
    0::numeric,
    'cancelled',
    null,
    jsonb_build_object(
      'kind', p_reason,
      'cancelled_at', now(),
      'prior_status', v_prior_status,
      'stopped_children', v_stopped_children
    )
  );

  return jsonb_build_object(
    'ok', true,
    'cancelled', true,
    'prior_status', v_prior_status,
    'stopped_children', v_stopped_children,
    'ledger_id', v_ledger_id
  );
end $$;

revoke all on function cancel_conductor_run(uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function cancel_conductor_run(uuid, uuid, text, timestamptz) to service_role;

commit;
