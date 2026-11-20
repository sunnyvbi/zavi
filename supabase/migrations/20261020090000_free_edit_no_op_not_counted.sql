
begin;

create or replace function _free_edits_used(p_tenant_id uuid, p_exclude uuid)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  with waived as (
    select c.status = 'done'
           and coalesce((c.goal_graph #>> '{0,payload,no_change}')::boolean, false) as no_op
      from conductor_runs c
     where c.tenant_id = p_tenant_id
       and c.kind = 'build_app'
       and c.credits_waived
       and c.id is distinct from p_exclude
       and coalesce((c.goal_graph #>> '{0,payload,refine_mode}')::boolean, false)
       and not _is_waived_refine(
             p_tenant_id,
             case when (c.goal_graph #>> '{0,payload,retry_of}')
                       ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then (c.goal_graph #>> '{0,payload,retry_of}')::uuid end)
       and (c.status in ('provisioning', 'active')
            or exists (
              select 1 from agent_runs a
               where a.tenant_id = p_tenant_id
                 and a.payload->>'build_conductor_run_id' = c.id::text))
  )
  select ((count(*) filter (where not no_op))
          + greatest(0, (count(*) filter (where no_op)) - 3))::int
    from waived
$$;

revoke all on function _free_edits_used(uuid, uuid) from public, anon, authenticated;

commit;
