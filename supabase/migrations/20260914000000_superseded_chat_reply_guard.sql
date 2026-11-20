create or replace function stamp_superseded_chat_reply()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_superseded_by text;
  v_superseded_at text;
begin
  if new.sender_role <> 'assistant' or new.agent_run_id is null then
    return new;
  end if;

  select
    source_message.meta ->> 'superseded_by',
    source_message.meta ->> 'superseded_at'
  into v_superseded_by, v_superseded_at
  from agent_runs run
  join agent_thread_messages source_message
    on source_message.id::text = run.payload ->> 'user_message_id'
  where run.id = new.agent_run_id
    and run.tenant_id = new.tenant_id
    and source_message.tenant_id = new.tenant_id
    and source_message.thread_id = new.thread_id
  for update of source_message;

  if v_superseded_by is not null then
    new.meta := coalesce(new.meta, '{}'::jsonb) || jsonb_build_object(
      'superseded_by', v_superseded_by,
      'superseded_at', coalesce(v_superseded_at, now()::text)
    );
  end if;

  return new;
end;
$$;

drop trigger if exists stamp_superseded_chat_reply on agent_thread_messages;

create trigger stamp_superseded_chat_reply
before insert on agent_thread_messages
for each row execute function stamp_superseded_chat_reply();

revoke all on function stamp_superseded_chat_reply() from public;
