
alter table public.agent_threads
  add column if not exists sdk_session_id text;

comment on column public.agent_threads.sdk_session_id is
  'Anthropic Agent SDK session UUID from the most recent run on this thread. Read on chat-triggered turns >1 and passed as Options.resume so the SDK loads prior conversation natively. NULL on first turn or pre-2026-05-19 threads (dispatcher falls back to transcript-flatten).';
