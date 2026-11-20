
create or replace function claim_agent_run(p_run_id uuid)
returns agent_runs
language plpgsql security definer set search_path = public as $$
declare
  v_row agent_runs;
  v_tenant_id uuid;
  v_agent_slug text;
  v_trigger text;
  v_killed boolean;
begin
  select tenant_id, agent_slug, trigger
    into v_tenant_id, v_agent_slug, v_trigger
    from agent_runs
   where id = p_run_id;

  if v_tenant_id is null then
    return null;
  end if;

  select exists(
    select 1 from tenant_agent_kill_switch
     where tenant_id = v_tenant_id
       and agent_slug = v_agent_slug
  ) into v_killed;

  if v_killed then
    insert into enqueue_rejections (
      tenant_id, agent_slug, rejection_reason, body_fingerprint, trigger
    ) values (
      v_tenant_id,
      v_agent_slug,
      'kill_switch_at_claim',
      md5(p_run_id::text),
      coalesce(v_trigger, 'unknown')
    );
    return null;
  end if;

  update agent_runs
     set status = 'running', started_at = now()
   where id = p_run_id and status = 'queued'
   returning * into v_row;
  return v_row;
end $$;

revoke all on function claim_agent_run(uuid) from public;
