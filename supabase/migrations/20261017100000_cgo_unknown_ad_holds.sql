
begin;

alter table public.ad_budget_reservations
  add column if not exists provider_ref jsonb
    check (provider_ref is null
           or (jsonb_typeof(provider_ref) = 'object' and octet_length(provider_ref::text) <= 1024));

create or replace function public.note_ad_spend_ref(
  p_tenant_id uuid,
  p_idem_key  text,
  p_ref       jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget_id uuid;
  v_id        uuid;
begin
  if p_tenant_id is null or p_idem_key is null or btrim(p_idem_key) = '' then
    raise exception 'note_ad_spend_ref: tenant and idem_key are required';
  end if;
  if p_ref is null or jsonb_typeof(p_ref) <> 'object'
     or (p_ref->>'kind') not in ('meta_tag', 'meta_adset_name', 'google_campaign_name') then
    raise exception 'note_ad_spend_ref: invalid ref';
  end if;

  select budget_id into v_budget_id from ad_budget_reservations
   where tenant_id = p_tenant_id and idem_key = p_idem_key
   order by created_at desc limit 1;
  if v_budget_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform 1 from ad_budgets where id = v_budget_id and tenant_id = p_tenant_id for update;
  update ad_budget_reservations
     set provider_ref = p_ref, updated_at = now()
   where budget_id = v_budget_id and tenant_id = p_tenant_id and idem_key = p_idem_key
     and status = 'reserved' and object_id is null
     and (provider_ref is null or provider_ref = p_ref)
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('status', 'noted');
  end if;
  if exists (
    select 1 from ad_budget_reservations
     where budget_id = v_budget_id and tenant_id = p_tenant_id and idem_key = p_idem_key
       and status in ('reserved', 'committed')
       and object_id is not null
  ) then
    return jsonb_build_object('status', 'unchanged');
  end if;
  return jsonb_build_object('status', 'not_open');
end $$;

create or replace function public.resolve_unknown_ad_hold(
  p_tenant_id       uuid,
  p_hold_id         uuid,
  p_outcome         text,
  p_object_id       text,
  p_seen_updated_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res ad_budget_reservations%rowtype;
begin
  if p_tenant_id is null or p_hold_id is null or p_seen_updated_at is null then
    raise exception 'resolve_unknown_ad_hold: tenant, hold and seen_updated_at are required';
  end if;
  if p_outcome is null or p_outcome not in ('found', 'absent') then
    raise exception 'resolve_unknown_ad_hold: invalid outcome %', p_outcome;
  end if;
  if p_outcome = 'found'
     and (p_object_id is null or btrim(p_object_id) = '' or char_length(p_object_id) > 64) then
    raise exception 'resolve_unknown_ad_hold: invalid object id';
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

  if v_res.object_id is not null
     or v_res.status not in ('reserved', 'committed')
     or v_res.updated_at <> p_seen_updated_at
     or v_res.updated_at > now() - interval '2 hours' then
    return jsonb_build_object('status', 'stale');
  end if;

  if p_outcome = 'found' then
    update ad_budget_reservations
       set status = 'committed', object_id = p_object_id, updated_at = now()
     where id = v_res.id;
    return jsonb_build_object('status', 'resolved');
  end if;

  update ad_budget_reservations
     set status = 'released', reason = 'absent_on_platform',
         released_on = case when v_res.status = 'committed' then _ad_budget_today() else null end,
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

  if p_outcome = 'committed' and v_res.status = 'released' and v_res.reason = 'absent_on_platform' then
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

create or replace function public.note_ad_spend_object(
  p_tenant_id uuid,
  p_idem_key  text,
  p_object_id text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget_id uuid;
  v_id        uuid;
begin
  if p_tenant_id is null or p_idem_key is null or btrim(p_idem_key) = '' then
    raise exception 'note_ad_spend_object: tenant and idem_key are required';
  end if;
  if p_object_id is null or btrim(p_object_id) = '' or char_length(p_object_id) > 64 then
    raise exception 'note_ad_spend_object: invalid object id';
  end if;

  select budget_id into v_budget_id from ad_budget_reservations
   where tenant_id = p_tenant_id and idem_key = p_idem_key
   order by created_at desc limit 1;
  if v_budget_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform 1 from ad_budgets where id = v_budget_id and tenant_id = p_tenant_id for update;
  update ad_budget_reservations
     set object_id = p_object_id, updated_at = now()
   where budget_id = v_budget_id and tenant_id = p_tenant_id and idem_key = p_idem_key
     and status = 'reserved' and object_id is null
  returning id into v_id;
  if v_id is null then
    update ad_budget_reservations
       set object_id = p_object_id, status = 'reserved', reason = null, released_on = null, updated_at = now()
     where budget_id = v_budget_id and tenant_id = p_tenant_id and idem_key = p_idem_key
       and status = 'released' and reason = 'absent_on_platform' and object_id is null
    returning id into v_id;
  end if;

  return jsonb_build_object('status', case when v_id is null then 'unchanged' else 'noted' end);
end $$;

revoke all on function public.note_ad_spend_ref(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.resolve_unknown_ad_hold(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.settle_ad_spend(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.note_ad_spend_object(uuid, text, text) from public, anon, authenticated;

grant execute on function public.note_ad_spend_ref(uuid, text, jsonb) to service_role;
grant execute on function public.resolve_unknown_ad_hold(uuid, uuid, text, text, timestamptz) to service_role;
grant execute on function public.settle_ad_spend(uuid, text, text, text) to service_role;
grant execute on function public.note_ad_spend_object(uuid, text, text) to service_role;

commit;
