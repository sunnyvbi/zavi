
alter table memory_note
  add column if not exists thread_id uuid null;

update memory_note mn
   set thread_id = (ar.payload->>'thread_id')::uuid
  from agent_runs ar
 where mn.source = 'agent_run'
   and mn.source_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   and mn.source_ref::uuid = ar.id
   and ar.payload ? 'thread_id'
   and ar.payload->>'thread_id' is not null
   and mn.thread_id is null;

update memory_note mn
   set thread_id = (ar.payload->>'thread_id')::uuid
  from agent_runs ar
 where mn.source = 'episode_distill'
   and mn.source_ref like 'episode:%'
   and substring(mn.source_ref from 9) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   and substring(mn.source_ref from 9)::uuid = ar.id
   and ar.payload ? 'thread_id'
   and ar.payload->>'thread_id' is not null
   and mn.thread_id is null;

comment on column memory_note.thread_id is
  'Owning chat thread when this memory was distilled from a chat-trigger agent run (qa-blind-fixes 2026-05-26). Nullable. Drives the workspace cross-thread Brain tag in memory__search results.';
