
create or replace function distill_budget_increment(
  p_tenant_id uuid
) returns int
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  insert into distill_budget_ledger (tenant_id, day, count)
  values (p_tenant_id, current_date, 1)
  on conflict (tenant_id, day) do update
    set count = distill_budget_ledger.count + 1
  returning count into v_count;
  return v_count;
end $$;

revoke all on function distill_budget_increment(uuid) from public;
grant execute on function distill_budget_increment(uuid) to service_role;
