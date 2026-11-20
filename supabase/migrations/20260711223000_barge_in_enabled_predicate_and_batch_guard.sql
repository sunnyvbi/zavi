
create or replace function barge_in_enabled_for_tenant(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
           (select (c.blob->>'agent_barge_in_enabled')::boolean
              from public.system_config c where c.id = 1),
           false)
     and not coalesce(
           (select (c.blob->'agent_barge_in_disabled_tenants') ? p_tenant_id::text
              from public.system_config c where c.id = 1),
           false);
$$;

revoke all on function barge_in_enabled_for_tenant(uuid) from public, anon;
grant execute on function barge_in_enabled_for_tenant(uuid) to authenticated, service_role;

create or replace function enqueue_or_steer_chat_turn(
  p_tenant_id         uuid,
  p_thread_id         text,
  p_agent_slug        text,
  p_body              text,
  p_idempotency_key   text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_run_id   uuid;
  v_seq      bigint;
  v_steer_id uuid;
  v_existing uuid;
begin
  if v_uid is null then
    raise exception 'enqueue_or_steer_chat_turn: no authenticated caller';
  end if;
  if not exists (
    select 1 from public.tenant_users tu
    where tu.tenant_id = p_tenant_id and tu.user_id = v_uid
  ) then
    raise exception 'enqueue_or_steer_chat_turn: caller % not a member of tenant %', v_uid, p_tenant_id;
  end if;
  if p_body is null or length(btrim(p_body)) = 0 then
    raise exception 'enqueue_or_steer_chat_turn: empty body';
  end if;
  if length(p_body) > 8000 then
    raise exception 'enqueue_or_steer_chat_turn: body exceeds 8000 chars';
  end if;

  if not public.barge_in_enabled_for_tenant(p_tenant_id) then
    return jsonb_build_object('action', 'new_turn', 'reason', 'flag_off');
  end if;

  if not exists (
    select 1 from public.agent_threads t
    where t.id::text = p_thread_id
      and t.tenant_id = p_tenant_id
      and t.user_id = v_uid
  ) then
    return jsonb_build_object('action', 'new_turn', 'reason', 'not_thread_owner');
  end if;

  select id into v_run_id
  from public.agent_runs
  where tenant_id = p_tenant_id
    and status = 'running'
    and payload->>'thread_id' = p_thread_id
    and batch_id is null
  order by started_at desc nulls last
  limit 1
  for update;

  if v_run_id is null then
    return jsonb_build_object('action', 'new_turn', 'reason', 'no_running_run');
  end if;

  if p_idempotency_key is not null then
    select id into v_existing
    from public.agent_run_steers
    where run_id = v_run_id and idempotency_key = p_idempotency_key;
    if v_existing is not null then
      return jsonb_build_object('action', 'steered', 'steer_id', v_existing,
                                'run_id', v_run_id, 'dedup', true);
    end if;
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq
  from public.agent_run_steers where run_id = v_run_id;

  insert into public.agent_run_steers
    (tenant_id, run_id, thread_id, agent_slug, author_user_id, seq, body, origin, idempotency_key)
  values
    (p_tenant_id, v_run_id, p_thread_id, p_agent_slug, v_uid, v_seq, p_body, 'chat', p_idempotency_key)
  returning id into v_steer_id;

  return jsonb_build_object('action', 'steered', 'steer_id', v_steer_id, 'run_id', v_run_id);
end;
$$;

revoke all on function enqueue_or_steer_chat_turn(uuid, text, text, text, text) from public, anon;
grant execute on function enqueue_or_steer_chat_turn(uuid, text, text, text, text) to authenticated, service_role;

create or replace function enqueue_agent_run_steer(
  p_tenant_id        uuid,
  p_run_id           uuid,
  p_thread_id        text,
  p_agent_slug       text,
  p_author_user_id   uuid,
  p_body             text,
  p_origin           text,
  p_idempotency_key  text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status   text;
  v_batch    uuid;
  v_seq      bigint;
  v_steer_id uuid;
  v_existing uuid;
begin
  if p_origin not in ('slack','email','teams') then
    raise exception 'enqueue_agent_run_steer: origin % not a webhook surface', p_origin;
  end if;
  if p_body is null or length(btrim(p_body)) = 0 then
    raise exception 'enqueue_agent_run_steer: empty body';
  end if;
  if length(p_body) > 8000 then
    raise exception 'enqueue_agent_run_steer: body exceeds 8000 chars';
  end if;

  if not public.barge_in_enabled_for_tenant(p_tenant_id) then
    return jsonb_build_object('action', 'not_running', 'reason', 'flag_off');
  end if;

  select status, batch_id into v_status, v_batch
  from public.agent_runs
  where id = p_run_id
    and tenant_id = p_tenant_id
  for update;

  if v_status is null then
    return jsonb_build_object('action', 'not_running', 'reason', 'run_unresolved');
  end if;
  if v_status <> 'running' then
    return jsonb_build_object('action', 'not_running', 'reason', 'run_' || v_status);
  end if;
  if v_batch is not null then
    return jsonb_build_object('action', 'not_running', 'reason', 'batch_child');
  end if;

  if p_author_user_id is not null and not exists (
    select 1 from public.tenant_users tu
    where tu.tenant_id = p_tenant_id and tu.user_id = p_author_user_id
  ) then
    raise exception 'enqueue_agent_run_steer: author % not a member of tenant %', p_author_user_id, p_tenant_id;
  end if;

  if p_idempotency_key is not null then
    select id into v_existing
    from public.agent_run_steers
    where run_id = p_run_id and idempotency_key = p_idempotency_key;
    if v_existing is not null then
      return jsonb_build_object('action', 'steered', 'steer_id', v_existing,
                                'run_id', p_run_id, 'dedup', true);
    end if;
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq
  from public.agent_run_steers where run_id = p_run_id;

  insert into public.agent_run_steers
    (tenant_id, run_id, thread_id, agent_slug, author_user_id, seq, body, origin, idempotency_key)
  values
    (p_tenant_id, p_run_id, p_thread_id, p_agent_slug, p_author_user_id, v_seq, p_body, p_origin, p_idempotency_key)
  returning id into v_steer_id;

  return jsonb_build_object('action', 'steered', 'steer_id', v_steer_id, 'run_id', p_run_id);
end;
$$;

revoke all on function enqueue_agent_run_steer(uuid, uuid, text, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function enqueue_agent_run_steer(uuid, uuid, text, text, uuid, text, text, text) to service_role;

create or replace function drain_agent_run_steers(
  p_run_id        uuid,
  p_tenant_id     uuid,
  p_after_seq     bigint,
  p_max           int,
  p_lease_seconds int default 30
) returns setof agent_run_steers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.agent_runs r
    where r.id = p_run_id
      and r.tenant_id = p_tenant_id
      and r.batch_id is null
  ) then
    return;
  end if;

  return query
  with candidates as (
    select s.id
    from public.agent_run_steers s
    where s.run_id = p_run_id
      and s.tenant_id = p_tenant_id
      and s.seq > p_after_seq
      and (
        s.status = 'pending'
        or (s.status = 'leased' and s.lease_until is not null and s.lease_until < now())
      )
    order by s.seq
    limit greatest(p_max, 0)
    for update skip locked
  )
  update public.agent_run_steers s
     set status = 'leased',
         lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 1))
    from candidates c
   where s.id = c.id
  returning s.*;
end;
$$;

revoke all on function drain_agent_run_steers(uuid, uuid, bigint, int, int) from public, anon, authenticated;
grant execute on function drain_agent_run_steers(uuid, uuid, bigint, int, int) to service_role;

comment on function barge_in_enabled_for_tenant(uuid) is
  'Single source of truth for mid-run barge-in liveness: global system_config.blob.agent_barge_in_enabled AND tenant not in agent_barge_in_disabled_tenants. TS twin: engine/db-steer-source.ts isBargeInEnabledForTenant — keep in step.';
