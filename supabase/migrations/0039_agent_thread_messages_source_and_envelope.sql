
alter table agent_thread_messages
  add column if not exists source text not null default 'chat'
    check (source in ('chat', 'cron', 'a2a', 'manual'));

create index if not exists agent_thread_messages_source
  on agent_thread_messages (source) where source <> 'chat';

comment on column agent_thread_messages.source is
  'Origin of the row: chat (user turn) | cron (cron-fired run summary, R9) '
  '| a2a (cross-agent dispatch summary) | manual (operator Run Now summary).';

create or replace function record_agent_chat_reply(
  p_thread_id uuid,
  p_tenant_id uuid,
  p_expected_agent_slug text,
  p_run_id uuid,
  p_body text,
  p_meta jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
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
  'Worker-side. Persists assistant chat reply. p_meta carries optional '
  'envelope JSON for output_envelope agents (R7). Cross-checks thread/tenant/slug.';
