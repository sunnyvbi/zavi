create index if not exists agent_thread_messages_user_attachments_gin
  on public.agent_thread_messages using gin (attachments jsonb_path_ops)
  where sender_role = 'user' and attachments is not null;
