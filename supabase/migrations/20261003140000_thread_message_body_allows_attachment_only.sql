alter table agent_thread_messages
  drop constraint if exists agent_thread_messages_body_check;

alter table agent_thread_messages
  add constraint agent_thread_messages_body_check
  check (
    length(body) <= 32000
    and (
      length(body) >= 1
      or case
        when jsonb_typeof(attachments) = 'array' then jsonb_array_length(attachments) > 0
        else false
      end
    )
  );
