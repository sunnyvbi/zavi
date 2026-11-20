
create or replace function public.release_budget_reservation(
  p_tenant_id uuid,
  p_day       date,
  p_estimate  numeric
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_released numeric;
begin
  if p_tenant_id is null or p_day is null or p_estimate is null then
    raise exception 'release_budget_reservation: null argument' using errcode = '22023';
  end if;
  if p_estimate < 0 then
    raise exception 'release_budget_reservation: estimate must be >= 0' using errcode = '22023';
  end if;

  update tenant_budget_counters
     set spend_estimate = greatest(0, spend_estimate - p_estimate),
         run_count = greatest(0, run_count - 1),
         updated_at = now()
   where tenant_id = p_tenant_id
     and day = p_day
  returning spend_estimate into v_released;

  return v_released is not null;
end $$;

revoke all on function public.release_budget_reservation(uuid, date, numeric) from public, anon, authenticated;
grant execute on function public.release_budget_reservation(uuid, date, numeric) to service_role;
