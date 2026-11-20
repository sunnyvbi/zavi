
begin;

alter table public.ad_budgets
  add column if not exists end_note_sent_at timestamptz,
  add column if not exists closed_at        timestamptz;

create or replace function public.ended_ad_budget_holds(
  p_tenant_id uuid,
  p_budget_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget  ad_budgets%rowtype;
  v_objects jsonb;
  v_paused  jsonb;
begin
  if p_tenant_id is null or p_budget_id is null then
    raise exception 'ended_ad_budget_holds: tenant and budget are required';
  end if;

  select * into v_budget from ad_budgets
   where id = p_budget_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found', 'objects', '[]'::jsonb);
  end if;
  if v_budget.status <> 'ended' then
    return jsonb_build_object('status', v_budget.status, 'objects', '[]'::jsonb);
  end if;
  if v_budget.closed_at is not null then
    return jsonb_build_object('status', 'closed', 'objects', '[]'::jsonb);
  end if;

  update ad_budget_reservations r
     set status = 'released', reason = 'handed_over', updated_at = now()
   where r.budget_id = v_budget.id and r.tenant_id = p_tenant_id
     and r.status = 'committed' and r.object_id is not null
     and exists (
       select 1 from ad_budget_reservations n
         join ad_budgets a on a.id = n.budget_id
        where a.tenant_id = p_tenant_id and a.status = 'active'
          and n.platform = r.platform and n.object_id = r.object_id
          and n.status = 'committed');

  select coalesce(jsonb_agg(jsonb_build_object('platform', platform, 'object_id', object_id, 'in_flight', in_flight)
                            order by platform, object_id), '[]'::jsonb)
    into v_objects
    from (
      select r.platform, r.object_id, bool_or(r.status = 'reserved') as in_flight
        from ad_budget_reservations r
       where r.budget_id = v_budget.id and r.tenant_id = p_tenant_id
         and r.status in ('reserved', 'committed') and r.object_id is not null
         and not exists (
           select 1 from ad_budget_reservations n
             join ad_budgets a on a.id = n.budget_id
            where a.tenant_id = p_tenant_id and a.status = 'active'
              and n.platform = r.platform and n.object_id = r.object_id
              and n.status in ('reserved', 'committed'))
       group by r.platform, r.object_id
    ) o;

  select coalesce(jsonb_agg(jsonb_build_object('platform', platform, 'object_id', object_id)
                            order by platform, object_id), '[]'::jsonb)
    into v_paused
    from (
      select distinct platform, object_id
        from ad_budget_reservations
       where budget_id = v_budget.id and tenant_id = p_tenant_id
         and status = 'released' and reason = 'budget_ended' and object_id is not null
    ) p;

  if v_budget.end_note_sent_at is not null and not exists (
       select 1 from ad_budget_reservations
        where budget_id = v_budget.id and tenant_id = p_tenant_id
          and status in ('reserved', 'committed') and object_id is not null) then
    update ad_budgets set closed_at = now(), updated_at = now() where id = v_budget.id;
    return jsonb_build_object('status', 'closed', 'objects', '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'status', 'ended',
    'objects', v_objects,
    'paused_before', v_paused,
    'note_due', v_budget.end_note_sent_at is null,
    'ends_on', v_budget.ends_on,
    'actual_usd', v_budget.actual_usd,
    'total_usd', v_budget.total_usd);
end $$;

create or replace function public.release_ad_spend_for_object(
  p_tenant_id uuid,
  p_platform  text,
  p_object_id text,
  p_budget_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_res    ad_budget_reservations%rowtype;
  v_left   int;
  v_back   numeric(12,2);
  v_total  numeric(12,2) := 0;
begin
  if p_tenant_id is null or p_platform is null or p_object_id is null then
    raise exception 'release_ad_spend_for_object: tenant, platform and object are required';
  end if;

  if p_budget_id is null then
    select * into v_budget from ad_budgets
     where tenant_id = p_tenant_id and status = 'active'
     for update;
  else
    select * into v_budget from ad_budgets
     where id = p_budget_id and tenant_id = p_tenant_id and status in ('active', 'stopped', 'ended')
     for update;
  end if;
  if not found then
    return jsonb_build_object('status', 'no_budget', 'released_usd', 0);
  end if;

  v_left := greatest(v_budget.ends_on - current_date, 0);
  for v_res in
    select * from ad_budget_reservations
     where budget_id = v_budget.id and platform = p_platform
       and object_id = p_object_id and status = 'committed'
     for update
  loop
    v_back := least(
      v_res.amount_usd - v_res.released_usd,
      floor(v_res.daily_delta_usd * v_left * v_budget.margin * 100) / 100
    );
    update ad_budget_reservations
       set status = 'released', released_usd = released_usd + v_back,
           reason = case v_budget.status
                      when 'stopped' then 'budget_stopped'
                      when 'ended' then 'budget_ended'
                      else reason end,
           updated_at = now()
     where id = v_res.id;
    v_total := v_total + v_back;
  end loop;

  if v_total > 0 then
    update ad_budgets
       set committed_usd = greatest(committed_usd - v_total, 0), updated_at = now()
     where id = v_budget.id;
  end if;
  return jsonb_build_object('status', 'released', 'released_usd', v_total);
end $$;

create or replace function public.claim_ad_budget_end_note(
  p_tenant_id uuid,
  p_budget_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if p_tenant_id is null or p_budget_id is null then
    raise exception 'claim_ad_budget_end_note: tenant and budget are required';
  end if;
  update ad_budgets set end_note_sent_at = now(), updated_at = now()
   where id = p_budget_id and tenant_id = p_tenant_id
     and status = 'ended' and end_note_sent_at is null
  returning id into v_id;
  return jsonb_build_object('claimed', v_id is not null);
end $$;

create or replace function public.release_ad_budget_end_note(
  p_tenant_id uuid,
  p_budget_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if p_tenant_id is null or p_budget_id is null then
    raise exception 'release_ad_budget_end_note: tenant and budget are required';
  end if;
  update ad_budgets set end_note_sent_at = null, updated_at = now()
   where id = p_budget_id and tenant_id = p_tenant_id and closed_at is null
  returning id into v_id;
  return jsonb_build_object('status', case when v_id is null then 'not_found' else 'released' end);
end $$;

revoke all on function public.ended_ad_budget_holds(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_ad_spend_for_object(uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.claim_ad_budget_end_note(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_ad_budget_end_note(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ended_ad_budget_holds(uuid, uuid) to service_role;
grant execute on function public.release_ad_spend_for_object(uuid, text, text, uuid) to service_role;
grant execute on function public.claim_ad_budget_end_note(uuid, uuid) to service_role;
grant execute on function public.release_ad_budget_end_note(uuid, uuid) to service_role;

commit;
