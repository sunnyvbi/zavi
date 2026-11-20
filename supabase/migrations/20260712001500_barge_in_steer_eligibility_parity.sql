
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
  v_msg_id   uuid;
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
      and t.agent_slug = p_agent_slug
      and t.deleted_at is null
  ) then
    return jsonb_build_object('action', 'new_turn', 'reason', 'not_thread_owner');
  end if;

  select id into v_run_id
  from public.agent_runs
  where tenant_id = p_tenant_id
    and status = 'running'
    and trigger = 'chat'
    and agent_slug = p_agent_slug
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
                                'run_id', v_run_id, 'thread_id', p_thread_id,
                                'dedup', true);
    end if;
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq
  from public.agent_run_steers where run_id = v_run_id;

  insert into public.agent_run_steers
    (tenant_id, run_id, thread_id, agent_slug, author_user_id, seq, body, origin, idempotency_key)
  values
    (p_tenant_id, v_run_id, p_thread_id, p_agent_slug, v_uid, v_seq, p_body, 'chat', p_idempotency_key)
  returning id into v_steer_id;

  insert into public.agent_thread_messages
    (thread_id, tenant_id, sender_role, body, agent_run_id)
  values
    (p_thread_id::uuid, p_tenant_id, 'user', p_body, v_run_id)
  returning id into v_msg_id;

  update public.agent_threads
     set last_message_at = now()
   where id = p_thread_id::uuid
     and tenant_id = p_tenant_id;

  return jsonb_build_object(
    'action', 'steered',
    'steer_id', v_steer_id,
    'run_id', v_run_id,
    'thread_id', p_thread_id,
    'user_message_id', v_msg_id
  );
end;
$$;

revoke all on function enqueue_or_steer_chat_turn(uuid, text, text, text, text) from public, anon;
grant execute on function enqueue_or_steer_chat_turn(uuid, text, text, text, text) to authenticated, service_role;
