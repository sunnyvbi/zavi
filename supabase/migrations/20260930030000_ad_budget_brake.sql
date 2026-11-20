
begin;

alter table public.ad_budget_reservations drop constraint if exists ad_budget_reservations_op_check;
alter table public.ad_budget_reservations
  add constraint ad_budget_reservations_op_check check (op in ('raise', 'resume', 'create', 'rebase'));

create or replace function public.rebase_ad_spend_for_object(
  p_tenant_id     uuid,
  p_platform      text,
  p_object_id     text,
  p_new_daily_usd numeric,
  p_idem_key      text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_today  date;
  v_new    numeric(12,2);
  v_held   numeric(12,2);
begin
  if p_tenant_id is null or p_object_id is null or btrim(p_object_id) = ''
     or p_idem_key is null or btrim(p_idem_key) = '' then
    raise exception 'rebase_ad_spend_for_object: tenant, object and idem_key are required';
  end if;
  if p_platform is null or p_platform not in ('meta', 'google') then
    raise exception 'rebase_ad_spend_for_object: invalid platform %', p_platform;
  end if;
  if p_new_daily_usd is null or not (p_new_daily_usd >= 0 and p_new_daily_usd < 1000000) then
    raise exception 'rebase_ad_spend_for_object: invalid daily amount';
  end if;

  select * into v_budget from ad_budgets
   where tenant_id = p_tenant_id and status = 'active'
   for update;
  if not found then
    return jsonb_build_object('status', 'no_budget');
  end if;

  if exists (select 1 from ad_budget_reservations where budget_id = v_budget.id and idem_key = p_idem_key) then
    return jsonb_build_object('status', 'already_rebased');
  end if;

  if exists (
    select 1 from ad_budget_reservations
     where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
       and status = 'reserved') then
    return jsonb_build_object('status', 'object_busy');
  end if;

  select coalesce(sum(daily_delta_usd), 0) into v_held from ad_budget_reservations
   where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
     and status = 'committed';
  if v_held = 0 then
    return jsonb_build_object('status', 'no_hold');
  end if;

  v_new := ceil(p_new_daily_usd * 100) / 100;
  if v_new >= v_held then
    return jsonb_build_object('status', 'not_lower', 'daily_usd', v_held);
  end if;

  v_today := _ad_budget_today();
  update ad_budget_reservations
     set status = 'released', released_on = null, reason = 'rebased',
         pause_due = false, updated_at = now()
   where budget_id = v_budget.id and tenant_id = p_tenant_id
     and platform = p_platform and object_id = p_object_id and status = 'committed';

  insert into ad_budget_reservations
    (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status)
  values
    (v_budget.id, p_tenant_id, p_idem_key, p_platform, p_object_id, 'rebase', v_new,
     ceil(v_new * _ad_budget_days_left(v_today) * v_budget.margin * 100) / 100, 'committed');

  return jsonb_build_object('status', 'rebased', 'daily_usd', v_new, 'released_daily_usd', v_held);
end $$;

alter table public.ad_budgets add column if not exists brake_checked_for date;

create or replace function public.claim_ad_budget_brake(
  p_tenant_id uuid,
  p_budget_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id    uuid;
  v_today date := _ad_budget_today();
begin
  if p_tenant_id is null or p_budget_id is null then
    raise exception 'claim_ad_budget_brake: tenant and budget are required';
  end if;
  update ad_budgets set brake_checked_for = v_today, updated_at = now()
   where id = p_budget_id and tenant_id = p_tenant_id and status = 'active'
     and brake_checked_for is distinct from v_today
  returning id into v_id;
  return jsonb_build_object('claimed', v_id is not null, 'day', v_today);
end $$;

create or replace function public.release_ad_budget_brake(
  p_tenant_id uuid,
  p_budget_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if p_tenant_id is null or p_budget_id is null then
    raise exception 'release_ad_budget_brake: tenant and budget are required';
  end if;
  update ad_budgets set brake_checked_for = null, updated_at = now()
   where id = p_budget_id and tenant_id = p_tenant_id
  returning id into v_id;
  return jsonb_build_object('status', case when v_id is null then 'not_found' else 'released' end);
end $$;

revoke all on function public.rebase_ad_spend_for_object(uuid, text, text, numeric, text) from public, anon, authenticated;
revoke all on function public.claim_ad_budget_brake(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_ad_budget_brake(uuid, uuid) from public, anon, authenticated;
grant execute on function public.rebase_ad_spend_for_object(uuid, text, text, numeric, text) to service_role;
grant execute on function public.claim_ad_budget_brake(uuid, uuid) to service_role;
grant execute on function public.release_ad_budget_brake(uuid, uuid) to service_role;

commit;
