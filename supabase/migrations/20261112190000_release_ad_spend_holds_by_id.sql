
create or replace function public.release_ad_spend_holds(
  p_tenant_id       uuid,
  p_platform        text,
  p_object_id       text,
  p_reservation_ids uuid[]
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_today  date;
  v_daily  numeric(12,2);
  v_count  integer;
begin
  if p_tenant_id is null or p_platform is null or p_object_id is null or p_reservation_ids is null then
    raise exception 'release_ad_spend_holds: tenant, platform, object and hold ids are required';
  end if;

  select * into v_budget from ad_budgets
   where tenant_id = p_tenant_id and status = 'active'
   for update;
  if not found then
    return jsonb_build_object('status', 'no_budget', 'released_usd', 0, 'released', 0);
  end if;

  v_today := _ad_budget_today();
  with rel as (
    update ad_budget_reservations
       set status = 'released', released_on = v_today,
           reason = case when pause_due then 'month_rollover' else 'paused' end,
           pause_due = false, updated_at = now()
     where budget_id = v_budget.id and tenant_id = p_tenant_id
       and platform = p_platform and object_id = p_object_id and status = 'committed'
       and id = any(p_reservation_ids)
    returning daily_delta_usd
  )
  select coalesce(sum(daily_delta_usd), 0), count(*) into v_daily, v_count from rel;

  return jsonb_build_object('status', 'released', 'released', v_count,
    'released_usd', (floor(v_daily * greatest(_ad_budget_days_left(v_today) - 1, 0) * v_budget.margin * 100) / 100)::numeric(12,2));
end $$;

revoke all on function public.release_ad_spend_holds(uuid, text, text, uuid[]) from public, anon, authenticated;
grant execute on function public.release_ad_spend_holds(uuid, text, text, uuid[]) to service_role;
