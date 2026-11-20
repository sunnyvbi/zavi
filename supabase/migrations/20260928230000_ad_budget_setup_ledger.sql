
begin;

create table if not exists public.ad_budget_human_actions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  budget_id   uuid not null references public.ad_budgets(id) on delete cascade,
  occurred_at date not null,
  note        text not null check (char_length(btrim(note)) between 1 and 500),
  amount_usd  numeric(12,2) check (amount_usd is null or (amount_usd >= 0 and amount_usd < 1000000)),
  created_by  uuid not null,
  created_at  timestamptz not null default now()
);
create index if not exists ad_budget_human_actions_budget
  on public.ad_budget_human_actions (budget_id, occurred_at desc);

alter table public.ad_budget_human_actions enable row level security;

create policy ad_budget_human_actions_member_select on public.ad_budget_human_actions
  for select using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = ad_budget_human_actions.tenant_id
    )
  );
create policy ad_budget_human_actions_active_tenant_restrict
  on public.ad_budget_human_actions as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

revoke all on public.ad_budget_human_actions from public, anon;
revoke insert, update, delete, truncate on public.ad_budget_human_actions from authenticated;
grant select on public.ad_budget_human_actions to authenticated;
grant all on public.ad_budget_human_actions to service_role;

alter table public.ad_budgets add column if not exists stopped_at timestamptz;
alter table public.ad_budgets add column if not exists stopped_by uuid;

create or replace function public._ad_budget_assert_manager(p_tenant_id uuid, p_actor uuid)
returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null or p_actor is null then
    raise exception 'ad_budget: tenant and actor are required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from tenant_users
     where tenant_id = p_tenant_id and user_id = p_actor and role in ('owner', 'admin')
  ) then
    raise exception 'ad_budget: actor is not an owner or admin of this tenant' using errcode = '42501';
  end if;
end $$;

create or replace function public.create_ad_budget(
  p_tenant_id       uuid,
  p_actor           uuid,
  p_total_usd       numeric,
  p_daily_limit_usd numeric,
  p_ends_on         date
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  perform _ad_budget_assert_manager(p_tenant_id, p_actor);
  if _tenant_tier(p_tenant_id) <> 'pro' then
    raise exception 'ad_budget: the Pro plan is required' using errcode = '42501';
  end if;
  if p_total_usd is null or not (p_total_usd > 0 and p_total_usd < 10000000) then
    raise exception 'ad_budget: invalid total' using errcode = '22023';
  end if;
  if p_daily_limit_usd is not null and not (p_daily_limit_usd > 0 and p_daily_limit_usd <= p_total_usd) then
    raise exception 'ad_budget: invalid daily limit' using errcode = '22023';
  end if;
  if p_ends_on is null or p_ends_on <= current_date or p_ends_on > current_date + 90 then
    raise exception 'ad_budget: invalid end date' using errcode = '22023';
  end if;

  update ad_budgets set status = 'ended', updated_at = now()
   where tenant_id = p_tenant_id and status = 'active' and ends_on < current_date;

  if exists (
    select 1 from ad_budgets b
      join ad_budget_reservations r on r.budget_id = b.id
     where b.tenant_id = p_tenant_id and b.status = 'stopped'
       and r.status in ('reserved', 'committed') and r.object_id is not null
  ) then
    return jsonb_build_object('status', 'outstanding_holds');
  end if;

  begin
    insert into ad_budgets (tenant_id, total_usd, daily_limit_usd, ends_on, created_by)
    values (p_tenant_id, round(p_total_usd, 2), round(p_daily_limit_usd, 2), p_ends_on, p_actor)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('status', 'already_active');
  end;
  return jsonb_build_object('status', 'created', 'budget_id', v_id);
end $$;

create or replace function public.update_ad_budget(
  p_tenant_id       uuid,
  p_actor           uuid,
  p_budget_id       uuid,
  p_total_usd       numeric,
  p_daily_limit_usd numeric,
  p_ends_on         date
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_extra_days int;
  v_extra numeric(12,2) := 0;
  v_total numeric(12,2);
begin
  perform _ad_budget_assert_manager(p_tenant_id, p_actor);
  if _tenant_tier(p_tenant_id) <> 'pro' then
    raise exception 'ad_budget: the Pro plan is required' using errcode = '42501';
  end if;
  if p_total_usd is null or not (p_total_usd > 0 and p_total_usd < 10000000) then
    raise exception 'ad_budget: invalid total' using errcode = '22023';
  end if;
  if p_daily_limit_usd is not null and not (p_daily_limit_usd > 0 and p_daily_limit_usd <= p_total_usd) then
    raise exception 'ad_budget: invalid daily limit' using errcode = '22023';
  end if;
  if p_ends_on is null or p_ends_on <= current_date or p_ends_on > current_date + 90 then
    raise exception 'ad_budget: invalid end date' using errcode = '22023';
  end if;

  select * into v_budget from ad_budgets
   where id = p_budget_id and tenant_id = p_tenant_id and status = 'active'
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  v_total := round(p_total_usd, 2);
  if v_total < v_budget.committed_usd + greatest(v_budget.actual_usd, 0) then
    return jsonb_build_object('status', 'below_committed',
      'committed_usd', v_budget.committed_usd + greatest(v_budget.actual_usd, 0));
  end if;

  v_extra_days := greatest(p_ends_on - v_budget.ends_on, 0);
  if v_extra_days > 0 then
    select coalesce(sum(ceil(daily_delta_usd * v_extra_days * v_budget.margin * 100) / 100), 0)
      into v_extra
      from ad_budget_reservations
     where budget_id = v_budget.id and status in ('reserved', 'committed');
    if v_budget.committed_usd + greatest(v_budget.actual_usd, 0) + v_extra > v_total then
      return jsonb_build_object('status', 'extension_over_total',
        'committed_usd', v_budget.committed_usd + greatest(v_budget.actual_usd, 0),
        'needed_usd', v_extra);
    end if;
    update ad_budget_reservations
       set amount_usd = amount_usd + ceil(daily_delta_usd * v_extra_days * v_budget.margin * 100) / 100,
           updated_at = now()
     where budget_id = v_budget.id and status in ('reserved', 'committed');
  end if;

  update ad_budgets
     set total_usd = v_total,
         daily_limit_usd = round(p_daily_limit_usd, 2),
         ends_on = p_ends_on,
         committed_usd = committed_usd + v_extra,
         updated_at = now()
   where id = v_budget.id;
  return jsonb_build_object('status', 'updated');
end $$;

create or replace function public.stop_ad_budget(
  p_tenant_id uuid,
  p_actor     uuid,
  p_budget_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_status text;
  v_objects jsonb;
begin
  perform _ad_budget_assert_manager(p_tenant_id, p_actor);

  select * into v_budget from ad_budgets
   where id = p_budget_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found', 'objects', '[]'::jsonb);
  end if;

  if v_budget.status = 'active' then
    update ad_budgets
       set status = 'stopped', stopped_at = now(), stopped_by = p_actor, updated_at = now()
     where id = v_budget.id;
    v_status := 'stopped';
  else
    v_status := 'already_stopped';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('platform', platform, 'object_id', object_id, 'in_flight', in_flight)
                            order by platform, object_id), '[]'::jsonb)
    into v_objects
    from (
      select platform, object_id, bool_or(status = 'reserved') as in_flight
        from ad_budget_reservations
       where budget_id = v_budget.id and tenant_id = p_tenant_id
         and status in ('reserved', 'committed') and object_id is not null
       group by platform, object_id
    ) o;
  return jsonb_build_object('status', v_status, 'objects', v_objects);
end $$;

drop function if exists public.release_ad_spend_for_object(uuid, text, text);
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
     where id = p_budget_id and tenant_id = p_tenant_id and status in ('active', 'stopped')
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
           reason = case when v_budget.status = 'stopped' then 'budget_stopped' else reason end,
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

create or replace function public.log_ad_budget_human_action(
  p_tenant_id   uuid,
  p_actor       uuid,
  p_budget_id   uuid,
  p_occurred_at date,
  p_note        text,
  p_amount_usd  numeric
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  perform _ad_budget_assert_manager(p_tenant_id, p_actor);
  if _tenant_tier(p_tenant_id) <> 'pro' then
    raise exception 'ad_budget: the Pro plan is required' using errcode = '42501';
  end if;
  if not exists (select 1 from ad_budgets where id = p_budget_id and tenant_id = p_tenant_id) then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_occurred_at is null or p_occurred_at > current_date + 1 or p_occurred_at < current_date - 365 then
    raise exception 'ad_budget: invalid date' using errcode = '22023';
  end if;
  if p_note is null or char_length(btrim(p_note)) not between 1 and 500 then
    raise exception 'ad_budget: invalid note' using errcode = '22023';
  end if;
  if p_amount_usd is not null and not (p_amount_usd >= 0 and p_amount_usd < 1000000) then
    raise exception 'ad_budget: invalid amount' using errcode = '22023';
  end if;

  insert into ad_budget_human_actions (tenant_id, budget_id, occurred_at, note, amount_usd, created_by)
  values (p_tenant_id, p_budget_id, p_occurred_at, btrim(p_note), round(p_amount_usd, 2), p_actor)
  returning id into v_id;
  return jsonb_build_object('status', 'logged', 'id', v_id);
end $$;

revoke all on function public._ad_budget_assert_manager(uuid, uuid) from public, anon, authenticated;
revoke all on function public.create_ad_budget(uuid, uuid, numeric, numeric, date) from public, anon, authenticated;
revoke all on function public.update_ad_budget(uuid, uuid, uuid, numeric, numeric, date) from public, anon, authenticated;
revoke all on function public.stop_ad_budget(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_ad_spend_for_object(uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.log_ad_budget_human_action(uuid, uuid, uuid, date, text, numeric) from public, anon, authenticated;
grant execute on function public._ad_budget_assert_manager(uuid, uuid) to service_role;
grant execute on function public.create_ad_budget(uuid, uuid, numeric, numeric, date) to service_role;
grant execute on function public.update_ad_budget(uuid, uuid, uuid, numeric, numeric, date) to service_role;
grant execute on function public.stop_ad_budget(uuid, uuid, uuid) to service_role;
grant execute on function public.release_ad_spend_for_object(uuid, text, text, uuid) to service_role;
grant execute on function public.log_ad_budget_human_action(uuid, uuid, uuid, date, text, numeric) to service_role;

commit;
