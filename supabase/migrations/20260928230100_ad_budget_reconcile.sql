
begin;

alter table public.ad_budgets
  add column if not exists actual_read_at   timestamptz,
  add column if not exists alarm_90_sent_at timestamptz;

create or replace function public.record_ad_budget_actual(
  p_tenant_id  uuid,
  p_budget_id  uuid,
  p_actual_usd numeric
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_alarm  boolean := false;
begin
  if p_tenant_id is null or p_budget_id is null then
    raise exception 'record_ad_budget_actual: tenant and budget are required';
  end if;
  if p_actual_usd is not null and not (p_actual_usd >= 0 and p_actual_usd < 1000000000) then
    raise exception 'record_ad_budget_actual: invalid actual';
  end if;

  select * into v_budget from ad_budgets
   where id = p_budget_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found', 'alarm', false);
  end if;
  if v_budget.status <> 'active' then
    return jsonb_build_object('status', v_budget.status, 'actual_usd', v_budget.actual_usd,
      'total_usd', v_budget.total_usd, 'committed_usd', v_budget.committed_usd, 'alarm', false);
  end if;

  if p_actual_usd is not null then
    update ad_budgets
       set actual_usd = greatest(actual_usd, ceil(p_actual_usd * 100) / 100),
           actual_read_at = now(), updated_at = now()
     where id = v_budget.id
    returning * into v_budget;
  end if;

  if v_budget.alarm_90_sent_at is null and v_budget.actual_usd >= v_budget.total_usd * 0.9 then
    update ad_budgets set alarm_90_sent_at = now(), updated_at = now()
     where id = v_budget.id
    returning * into v_budget;
    v_alarm := true;
  end if;

  if current_date > v_budget.ends_on then
    update ad_budgets set status = 'ended', updated_at = now()
     where id = v_budget.id
    returning * into v_budget;
  end if;

  return jsonb_build_object('status', v_budget.status, 'actual_usd', v_budget.actual_usd,
    'total_usd', v_budget.total_usd, 'committed_usd', v_budget.committed_usd, 'alarm', v_alarm);
end $$;

create or replace function public.release_ad_budget_alarm(
  p_tenant_id uuid,
  p_budget_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if p_tenant_id is null or p_budget_id is null then
    raise exception 'release_ad_budget_alarm: tenant and budget are required';
  end if;
  update ad_budgets set alarm_90_sent_at = null, updated_at = now()
   where id = p_budget_id and tenant_id = p_tenant_id
  returning id into v_id;
  return jsonb_build_object('status', case when v_id is null then 'not_found' else 'released' end);
end $$;

revoke all on function public.record_ad_budget_actual(uuid, uuid, numeric) from public, anon, authenticated;
revoke all on function public.release_ad_budget_alarm(uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_ad_budget_actual(uuid, uuid, numeric) to service_role;
grant execute on function public.release_ad_budget_alarm(uuid, uuid) to service_role;

commit;
