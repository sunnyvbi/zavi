
do $$
declare
  c_name text;
begin
  select conname into c_name
    from pg_constraint
   where conrelid = 'agent_runs'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%trigger%';
  if c_name is not null then
    execute format('alter table agent_runs drop constraint %I', c_name);
    alter table agent_runs
      add constraint agent_runs_trigger_check
      check (trigger in ('manual','cron','slack','webhook','a2a','chat','handoff'));
  end if;
end $$;

create or replace function record_handoff_chat_message(
  p_operator_thread_id uuid,
  p_tenant_id          uuid,
  p_run_id             uuid,
  p_body               text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id           uuid;
  v_agent_slug   text;
  v_trigger      text;
  v_payload_tid  uuid;
begin
  select r.agent_slug, r.trigger,
         (r.payload->>'operator_thread_id')::uuid
    into v_agent_slug, v_trigger, v_payload_tid
    from agent_runs r
   where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if v_agent_slug is null then
    raise exception 'run not found or wrong tenant' using errcode = '42501';
  end if;
  if v_trigger <> 'handoff' then
    raise exception 'run is not a handoff' using errcode = '42501';
  end if;
  if v_payload_tid is null or v_payload_tid <> p_operator_thread_id then
    raise exception 'operator_thread_id mismatch on payload' using errcode = '42501';
  end if;

  if not exists (
    select 1 from agent_threads
     where id = p_operator_thread_id
       and tenant_id = p_tenant_id
       and agent_slug = 'operator'
  ) then
    raise exception 'thread/tenant/slug mismatch' using errcode = '42501';
  end if;

  if length(coalesce(p_body, '')) = 0 or length(p_body) > 32000 then
    raise exception 'body length out of bounds' using errcode = '22023';
  end if;

  insert into agent_thread_messages
    (thread_id, tenant_id, sender_role, body, agent_run_id, meta)
  values
    (p_operator_thread_id, p_tenant_id, 'assistant', p_body, p_run_id,
     jsonb_build_object('from_agent_slug', v_agent_slug, 'handoff', true))
  returning id into v_id;

  update agent_threads set last_message_at = now() where id = p_operator_thread_id;
  return v_id;
end $$;

revoke all on function record_handoff_chat_message(uuid, uuid, uuid, text) from public;
grant execute on function record_handoff_chat_message(uuid, uuid, uuid, text) to service_role;
