
update memory_note mn
   set thread_id = (ar.payload->>'thread_id')::uuid
  from agent_runs ar
 where mn.source = 'auto_distill_chat'
   and mn.source_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   and mn.source_ref::uuid = ar.id
   and ar.payload ? 'thread_id'
   and ar.payload->>'thread_id' is not null
   and mn.thread_id is null;
