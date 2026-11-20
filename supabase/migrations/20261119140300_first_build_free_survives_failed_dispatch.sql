create or replace function _first_build_free_eligible(p_tenant_id uuid, p_exclude uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select not exists (
    select 1
      from conductor_runs c
     where c.tenant_id = p_tenant_id
       and c.kind = 'build_app'
       and c.id is distinct from p_exclude
       and (
         c.spend_usd > 0
         or exists (
           select 1 from agent_runs a
            where a.tenant_id = p_tenant_id
              and a.payload->>'build_conductor_run_id' = c.id::text
              and (a.status is distinct from 'dispatch_error' or a.last_progress_at is not null)
         )
       )
  )
$$;
revoke all on function _first_build_free_eligible(uuid, uuid) from public, anon, authenticated;
