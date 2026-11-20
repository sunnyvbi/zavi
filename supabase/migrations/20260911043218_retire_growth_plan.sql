create or replace function retire_growth_plan(p_tenant_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  if p_tenant_id is null then
    raise exception 'retire_growth_plan: tenant_id required'
      using errcode = '22023';
  end if;

  update growth_plan_bets b
     set status = 'superseded', updated_at = now()
    from growth_plan p
   where b.plan_id = p.id
     and p.tenant_id = p_tenant_id
     and p.status = 'live'
     and b.status not in ('superseded', 'rejected');

  update growth_plan
     set status = 'superseded', updated_at = now()
   where tenant_id = p_tenant_id
     and status = 'live';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function retire_growth_plan(uuid) to service_role;
