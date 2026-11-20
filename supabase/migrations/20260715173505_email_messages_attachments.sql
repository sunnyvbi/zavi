
alter table public.email_messages
  add column if not exists attachments jsonb not null default '[]'::jsonb;

comment on column public.email_messages.attachments is
  'Refs to inbound doc attachments stored in agent-chat-docs/<tenant>/<uuid>.<ext>. Array of {storage_path, filename, mime_type, size_bytes}. Bytes live in storage, never here.';
