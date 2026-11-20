

with ranked as (
  select id,
         row_number() over (
           partition by agent_run_id
           order by created_at asc, id asc
         ) as rn
    from agent_thread_messages
   where sender_role = 'assistant'
     and agent_run_id is not null
)
delete from agent_thread_messages a
 using ranked r
 where a.id = r.id and r.rn > 1;

create unique index if not exists agent_thread_messages_one_assistant_per_run
  on agent_thread_messages (agent_run_id)
  where sender_role = 'assistant' and agent_run_id is not null;

comment on index agent_thread_messages_one_assistant_per_run is
  'Idempotency guard: at most one assistant chat reply per agent_run_id. '
  'Backstops record_agent_chat_reply against Inngest dispatch-step retries '
  '(see 20260517000001 header for prod-incident context).';

create or replace function record_agent_chat_reply(
  p_thread_id uuid,
  p_tenant_id uuid,
  p_expected_agent_slug text,
  p_run_id uuid,
  p_body text,
  p_meta jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_existing uuid;
begin
  if not exists (select 1 from agent_threads
                 where id = p_thread_id
                   and tenant_id = p_tenant_id
                   and agent_slug = p_expected_agent_slug) then
    raise exception 'thread/tenant/slug mismatch' using errcode = '42501';
  end if;

  if length(coalesce(p_body, '')) = 0 or length(p_body) > 32000 then
    raise exception 'reply length out of bounds' using errcode = '22023';
  end if;

  if p_meta is not null and jsonb_typeof(p_meta) <> 'object' then
    raise exception 'p_meta must be a json object' using errcode = '22023';
  end if;

  if p_run_id is not null then
    select id into v_existing
      from agent_thread_messages
     where agent_run_id = p_run_id
       and sender_role = 'assistant'
     limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  insert into agent_thread_messages
    (thread_id, tenant_id, sender_role, body, agent_run_id, meta, source)
  values
    (p_thread_id, p_tenant_id, 'assistant', p_body, p_run_id,
     coalesce(p_meta, '{}'::jsonb), 'chat')
  returning id into v_id;

  update agent_threads set last_message_at = now() where id = p_thread_id;
  return v_id;
end $$;

revoke all on function record_agent_chat_reply(uuid, uuid, text, uuid, text, jsonb) from public;
grant execute on function record_agent_chat_reply(uuid, uuid, text, uuid, text, jsonb) to service_role;

comment on function record_agent_chat_reply(uuid, uuid, text, uuid, text, jsonb) is
  'Worker-side. Persists assistant chat reply. Idempotent on agent_run_id — '
  're-calls with the same p_run_id return the existing row id rather than '
  'inserting a duplicate (Inngest step-retry guard, 2026-05-17). p_meta '
  'carries optional envelope JSON for output_envelope agents (R7). '
  'Cross-checks thread/tenant/slug.';
