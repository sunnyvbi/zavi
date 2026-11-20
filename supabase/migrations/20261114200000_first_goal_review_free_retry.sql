
begin;

create or replace function _is_first_goal_review(
  p_tenant_id uuid, p_agent_slug text, p_trigger text, p_enqueued_by uuid, p_cron_dedupe_key text
) returns boolean language sql immutable security definer set search_path = public, pg_temp as $$
  select p_cron_dedupe_key is not null
     and p_enqueued_by is null
     and p_trigger is not distinct from 'a2a'
     and p_agent_slug is not distinct from 'cgo'
     and p_tenant_id is not null
     and p_cron_dedupe_key in (
       p_tenant_id::text || ':cgo-first-review',
       p_tenant_id::text || ':cgo-first-review:retry'
     )
$$;
revoke all on function _is_first_goal_review(uuid, text, text, uuid, text) from public, anon, authenticated;
grant execute on function _is_first_goal_review(uuid, text, text, uuid, text) to service_role;

commit;
