
begin;

create or replace function _look_parked_at(p_graph jsonb)
returns timestamptz language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare v text;
begin
  select e.node->'payload'->>'await_look_parked_at' into v
    from jsonb_array_elements(case when jsonb_typeof(p_graph) = 'array' then p_graph else '[]'::jsonb end)
         with ordinality as e(node, ord)
   where jsonb_typeof(e.node) = 'object' and e.node->>'status' = 'pending'
   order by e.ord
   limit 1;
  return v::timestamptz;
exception when others then
  return null;
end;
$$;
revoke all on function _look_parked_at(jsonb) from public, anon, authenticated;

create or replace function expire_parked_look_run(
  p_tenant_id        uuid,
  p_conductor_run_id uuid,
  p_expiry_seconds   int default 1800
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status  text;
  v_graph   jsonb;
  v_idx     int;
  v_node    jsonb;
  v_site    uuid;
  v_parked  timestamptz;
  v_chosen  timestamptz;
  v_cancel  jsonb;
  v_reason  constant text := 'Waiting for your pick timed out. Start the build again and pick a website.';
begin
  if p_tenant_id is null or p_conductor_run_id is null or p_expiry_seconds is null or p_expiry_seconds < 60 then
    raise exception 'expire_parked_look_run: bad argument' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('build:' || p_tenant_id::text, 0));

  select status, goal_graph into v_status, v_graph
    from conductor_runs
   where id = p_conductor_run_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('state', 'not_found');
  end if;
  if v_status is distinct from 'active' then
    return jsonb_build_object('state', 'ended');
  end if;

  select (e.ord - 1)::int, e.node into v_idx, v_node
    from jsonb_array_elements(case when jsonb_typeof(v_graph) = 'array' then v_graph else '[]'::jsonb end)
         with ordinality as e(node, ord)
   where jsonb_typeof(e.node) = 'object' and e.node->>'status' = 'pending'
   order by e.ord
   limit 1;
  if v_node is null or (v_node->'payload'->'await_look') is distinct from 'true'::jsonb
     or (v_node->'payload'->>'site_id') is null
     or (v_node->'payload'->>'site_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return jsonb_build_object('state', 'not_parked');
  end if;
  v_site := (v_node->'payload'->>'site_id')::uuid;

  select chosen_at into v_chosen
    from site_design_briefs
   where site_id = v_site and tenant_id = p_tenant_id;
  if v_chosen is not null then
    return jsonb_build_object('state', 'picked');
  end if;

  begin
    v_parked := (v_node->'payload'->>'await_look_parked_at')::timestamptz;
  exception when others then
    v_parked := null;
  end;
  if v_parked is null then
    v_parked := now();
    update conductor_runs
       set goal_graph = jsonb_set(v_graph, array[v_idx::text, 'payload', 'await_look_parked_at'], to_jsonb(v_parked))
     where id = p_conductor_run_id and tenant_id = p_tenant_id;
    return jsonb_build_object('state', 'waiting', 'parked_at', v_parked);
  end if;

  if now() < v_parked + make_interval(secs => p_expiry_seconds) then
    return jsonb_build_object('state', 'waiting', 'parked_at', v_parked);
  end if;

  v_cancel := cancel_conductor_run(p_tenant_id, p_conductor_run_id, 'look_pick_timeout', null::timestamptz);
  if coalesce((v_cancel->>'cancelled')::boolean, false) is not true then
    return jsonb_build_object('state', 'ended', 'parked_at', v_parked);
  end if;
  update conductor_runs set failure_reason = v_reason
   where id = p_conductor_run_id and tenant_id = p_tenant_id and status = 'failed';
  update sites set last_error = v_reason
   where tenant_id = p_tenant_id and root_conductor_run_id = p_conductor_run_id and status = 'failed';
  return jsonb_build_object('state', 'expired', 'parked_at', v_parked);
end;
$$;

revoke all on function expire_parked_look_run(uuid, uuid, int) from public, anon, authenticated;
grant execute on function expire_parked_look_run(uuid, uuid, int) to service_role;

create or replace function pick_parked_look(
  p_tenant_id        uuid,
  p_conductor_run_id uuid,
  p_direction        text,
  p_user_id          uuid,
  p_expiry_seconds   int default 1800
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_check  jsonb;
  v_graph  jsonb;
  v_site   uuid;
  v_saved  uuid;
begin
  if p_direction is null or p_direction !~ '^[a-z][a-z0-9-]{1,30}$' then
    raise exception 'pick_parked_look: bad direction' using errcode = '22023';
  end if;
  v_check := expire_parked_look_run(p_tenant_id, p_conductor_run_id, p_expiry_seconds);
  if v_check->>'state' not in ('waiting', 'picked') then
    return v_check;
  end if;
  select goal_graph into v_graph from conductor_runs where id = p_conductor_run_id and tenant_id = p_tenant_id;
  select (e.node->'payload'->>'site_id')::uuid into v_site
    from jsonb_array_elements(v_graph) with ordinality as e(node, ord)
   where e.node->>'status' = 'pending'
   order by e.ord
   limit 1;
  update site_design_briefs
     set chosen_direction = p_direction, chosen_by = p_user_id, chosen_at = now(), updated_at = now()
   where site_id = v_site and tenant_id = p_tenant_id and sealed_at is null
  returning site_id into v_saved;
  if v_saved is null then
    return jsonb_build_object('state', 'sealed');
  end if;
  update conductor_runs set updated_at = now() where id = p_conductor_run_id and tenant_id = p_tenant_id;
  return jsonb_build_object('state', 'picked', 'parked_at', v_check->'parked_at');
end;
$$;

revoke all on function pick_parked_look(uuid, uuid, text, uuid, int) from public, anon, authenticated;
grant execute on function pick_parked_look(uuid, uuid, text, uuid, int) to service_role;

create or replace function expire_parked_look_runs(
  p_expiry_seconds int default 1800,
  p_limit          int default 200
) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r       record;
  v_count int := 0;
begin
  if p_expiry_seconds is null or p_expiry_seconds < 60 or p_limit is null or p_limit < 1 then
    raise exception 'expire_parked_look_runs: bad argument' using errcode = '22023';
  end if;
  for r in
    select c.id, c.tenant_id, _look_parked_at(c.goal_graph) as parked_at
      from conductor_runs c
     where c.status = 'active'
       and c.goal_graph @> '[{"status": "pending", "payload": {"await_look": true}}]'::jsonb
       and (_look_parked_at(c.goal_graph) is null
            or _look_parked_at(c.goal_graph) <= now() - make_interval(secs => p_expiry_seconds))
     order by (_look_parked_at(c.goal_graph) is null), _look_parked_at(c.goal_graph) asc
     limit p_limit
  loop
    if (expire_parked_look_run(r.tenant_id, r.id, p_expiry_seconds))->>'state' = 'expired' then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

revoke all on function expire_parked_look_runs(int, int) from public, anon, authenticated;
grant execute on function expire_parked_look_runs(int, int) to service_role;

commit;
