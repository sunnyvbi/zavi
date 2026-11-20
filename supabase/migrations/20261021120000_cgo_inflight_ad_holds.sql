
begin;

create or replace function public.resolve_inflight_ad_hold(
  p_tenant_id       uuid,
  p_hold_id         uuid,
  p_outcome         text,
  p_seen_updated_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res ad_budget_reservations%rowtype;
begin
  if p_tenant_id is null or p_hold_id is null or p_seen_updated_at is null then
    raise exception 'resolve_inflight_ad_hold: tenant, hold and seen_updated_at are required';
  end if;
  if p_outcome is null or p_outcome not in ('landed', 'not_landed') then
    raise exception 'resolve_inflight_ad_hold: invalid outcome %', p_outcome;
  end if;

  select * into v_res from ad_budget_reservations
   where id = p_hold_id and tenant_id = p_tenant_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  perform 1 from ad_budgets where id = v_res.budget_id and tenant_id = p_tenant_id for update;
  select * into v_res from ad_budget_reservations
   where id = p_hold_id and tenant_id = p_tenant_id
   for update;

  if v_res.status <> 'reserved'
     or v_res.object_id is null
     or v_res.op not in ('raise', 'resume')
     or v_res.updated_at <> p_seen_updated_at
     or v_res.updated_at > now() - interval '2 hours' then
    return jsonb_build_object('status', 'stale');
  end if;

  if p_outcome = 'landed' then
    update ad_budget_reservations
       set status = 'committed', updated_at = now()
     where id = v_res.id;
    return jsonb_build_object('status', 'committed');
  end if;

  update ad_budget_reservations
     set status = 'released', reason = 'not_landed', released_on = null,
         pause_due = false, updated_at = now()
   where id = v_res.id;
  return jsonb_build_object('status', 'released');
end $$;

create or replace function public.settle_ad_spend(
  p_tenant_id uuid,
  p_idem_key  text,
  p_outcome   text,
  p_object_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget_id uuid;
  v_res       ad_budget_reservations%rowtype;
begin
  if p_tenant_id is null or p_idem_key is null then
    raise exception 'settle_ad_spend: tenant and idem_key are required';
  end if;
  if p_outcome is null or p_outcome not in ('committed', 'released') then
    raise exception 'settle_ad_spend: invalid outcome %', p_outcome;
  end if;

  select budget_id into v_budget_id from ad_budget_reservations
   where tenant_id = p_tenant_id and idem_key = p_idem_key
   order by created_at desc limit 1;
  if v_budget_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform 1 from ad_budgets where id = v_budget_id and tenant_id = p_tenant_id for update;
  select * into v_res from ad_budget_reservations
   where budget_id = v_budget_id and idem_key = p_idem_key and tenant_id = p_tenant_id
   for update;

  if p_outcome = 'committed' and v_res.status = 'released' and v_res.reason in ('absent_on_platform', 'not_landed') then
    update ad_budget_reservations
       set status = 'committed', reason = null, released_on = null,
           object_id = coalesce(object_id, p_object_id), updated_at = now()
     where id = v_res.id;
    return jsonb_build_object('status', 'committed');
  end if;

  if v_res.status <> 'reserved' then
    return jsonb_build_object('status', v_res.status);
  end if;

  if p_outcome = 'committed' then
    update ad_budget_reservations
       set status = 'committed', object_id = coalesce(object_id, p_object_id), updated_at = now()
     where id = v_res.id;
    return jsonb_build_object('status', 'committed');
  end if;

  update ad_budget_reservations
     set status = 'released', reason = 'rejected', released_on = null, pause_due = false, updated_at = now()
   where id = v_res.id;
  return jsonb_build_object('status', 'released');
end $$;

revoke all on function public.resolve_inflight_ad_hold(uuid, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.settle_ad_spend(uuid, text, text, text) from public, anon, authenticated;

grant execute on function public.resolve_inflight_ad_hold(uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.settle_ad_spend(uuid, text, text, text) to service_role;

commit;
