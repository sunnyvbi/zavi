begin;

create or replace function claim_growth_intake_research(
  p_tenant_id uuid,
  p_day date,
  p_stale_pending_seconds int default 600
) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_claimed boolean := false;
begin
  insert into growth_intake_research (tenant_id, day, status)
  values (p_tenant_id, p_day, 'pending')
  on conflict (tenant_id, day) do nothing;

  if found then
    return true;
  end if;

  update growth_intake_research
     set status = 'pending', reason = null, updated_at = now(), fetched_at = now()
   where tenant_id = p_tenant_id
     and day = p_day
     and (
       (status = 'pending'
        and updated_at < now() - make_interval(secs => p_stale_pending_seconds))
       or (status = 'failed' and reason = 'no_domain_on_file')
     )
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

revoke all on function claim_growth_intake_research(uuid, date, int) from public, anon, authenticated;
grant execute on function claim_growth_intake_research(uuid, date, int) to service_role;

commit;
