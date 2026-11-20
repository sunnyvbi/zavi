
begin;

alter table public.run_artifacts
  add column if not exists agent_slug text,
  add column if not exists thread_id uuid;

update public.run_artifacts ra
set
  agent_slug = ar.agent_slug,
  thread_id = case
    when (ar.payload ->> 'thread_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (ar.payload ->> 'thread_id')::uuid
    else null
  end
from public.agent_runs ar
where ra.run_id = ar.id;

commit;
