
create or replace function _is_engineer_backend_run(
  p_slug text, p_enqueued_by uuid, p_trigger text, p_payload jsonb
) returns boolean language sql immutable set search_path = public, pg_temp as $$
  select p_slug = 'engineer'
     and p_enqueued_by is null
     and coalesce(p_payload->'founder_direct_agent_mention', 'false'::jsonb) <> 'true'::jsonb
     and (
       coalesce(p_trigger, '') not in ('chat','slack','teams','telegram','discord','whatsapp','imessage','email','manual')
       or coalesce(p_payload->>'kind', '') = 'engineer_pr_followup'
     )
$$;
revoke all on function _is_engineer_backend_run(text, uuid, text, jsonb) from public, anon, authenticated;

do $$
begin
  raise notice '20261111200000: engineer founder-mention gate (_is_engineer_backend_run)';
end $$;
