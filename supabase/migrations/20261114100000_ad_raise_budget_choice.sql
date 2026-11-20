begin;

create or replace function public._ad_row_can_spend(p_platform text, p_status text)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_platform = 'google' then p_status is not null and p_status = 'ENABLED'
    when p_platform in ('meta', 'chatgpt', 'reddit', 'x') then p_status is not null and p_status = 'ACTIVE'
    else p_status is null or upper(p_status) not in (
      'PAUSED', 'CAMPAIGN_PAUSED', 'DELETE', 'DELETED', 'ARCHIVED', 'COMPLETED', 'CANCELED',
      'DRAFT', 'PENDING_DELETION', 'BUDGETANDMANUALPAUSED', 'SUSPENDED')
  end
$$;

create or replace function public._ad_stale_accounts(p_tenant_id uuid)
returns text language sql volatile set search_path = public, pg_temp as $$
  with reads as (
    select c.platform, c.account_id, c.as_of, c.status
      from ad_campaigns c
     where c.tenant_id = p_tenant_id
       and c.as_of >= (date_trunc('month', _ad_budget_today())::date)::timestamp at time zone 'utc'
  ), newest as (
    select platform, account_id, max(as_of) as at from reads group by platform, account_id
  )
  select string_agg(n.platform || ':' || n.account_id, ';' order by n.platform, n.account_id)
    from newest n
   where n.at < clock_timestamp() - interval '26 hours'
     and exists (select 1 from reads r
                  where r.platform = n.platform and r.account_id = n.account_id and r.as_of = n.at
                    and _ad_row_can_spend(r.platform, r.status))
$$;

create or replace function public._ad_month_token(p_tenant_id uuid)
returns text language sql volatile set search_path = public, pg_temp as $$
  with b as (select * from ad_budgets where tenant_id = p_tenant_id and status = 'active' limit 1)
  select md5(concat_ws('|',
    coalesce((select (b.id, b.monthly_usd, b.daily_limit_usd, b.spent_usd, b.month_start, b.started_on, b.margin,
                      b.read_failed, b.actual_read_at, b.updated_at,
                      _creator_hire_used_usd(b.id, _ad_budget_today()))::text from b), 'no_budget'),
    coalesce((select string_agg((r.id, r.status, r.platform, r.object_id, r.daily_delta_usd, r.amount_usd,
                                 r.paused, r.pause_due, r.created_at)::text, ';' order by r.id)
                from ad_budget_reservations r join b on r.budget_id = b.id
               where r.status in ('reserved', 'committed')), ''),
    coalesce((select string_agg((c.platform, c.account_id, c.object_id, c.budget_kind, c.budget_usd, c.status, c.as_of)::text,
                                ';' order by c.platform, c.account_id, c.object_id)
                from ad_campaigns c where c.tenant_id = p_tenant_id and (c.status is null or c.status <> 'removed')), ''),
    coalesce((select string_agg((o.id, o.platform, o.object_id, o.change_kind, o.after_daily_usd, o.after_status, o.occurred_at)::text,
                                ';' order by o.id)
                from ad_object_changes o
               where o.tenant_id = p_tenant_id and o.occurred_at >= clock_timestamp() - interval '26 hours'), ''),
    coalesce(_ad_stale_accounts(p_tenant_id), ''),
    _ad_budget_today()::text))
$$;

create or replace function public.ad_month_token(p_tenant_id uuid)
returns text language sql volatile security definer set search_path = public, pg_temp as $$
  select _ad_month_token(p_tenant_id)
$$;

create or replace function public.approve_ad_raise_with_budget(
  p_tenant_id      uuid,
  p_decision_id    uuid,
  p_actor_user_id  uuid,
  p_token          text,
  p_expected_object_id       text,
  p_expected_daily_delta_usd numeric,
  p_monthly_to     numeric default null,
  p_daily_limit_to numeric default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget   ad_budgets%rowtype;
  v_dec      record;
  v_today    date := _ad_budget_today();
  v_idem     text := p_decision_id::text || ':raise';
  v_delta    numeric(12,2);
  v_amt      numeric(12,2);
  v_monthly  numeric(12,2);
  v_daily    numeric(12,2);
  v_live     numeric(12,2);
  v_edit     jsonb;
  v_flip     jsonb;
  v_res      ad_budget_reservations%rowtype;
  v_class    text;
  v_platform text;
  v_object   text;
  v_cap      numeric(12,2);
  v_used     numeric(12,2);
  v_own      uuid;
begin
  if p_tenant_id is null or p_decision_id is null or p_actor_user_id is null then
    raise exception 'approve_ad_raise_with_budget: tenant, decision and actor are required' using errcode = '22023';
  end if;

  select * into v_budget from ad_budgets where tenant_id = p_tenant_id and status = 'active' for update;
  if not found then
    return jsonb_build_object('status', 'no_budget');
  end if;

  select id, status, decision_class, body into v_dec from decisions
   where id = p_decision_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'not found: decision % for tenant', p_decision_id using errcode = '42501';
  end if;

  v_class := regexp_replace(coalesce(v_dec.decision_class, ''), '_review$', '');
  if v_class = 'google_ads.update_campaign_budget' then
    v_platform := 'google'; v_object := v_dec.body->>'campaign_id';
  elsif v_class = 'meta_ads.update_ad_set_budget' then
    v_platform := 'meta'; v_object := v_dec.body->>'ad_set_id';
  elsif v_class = 'meta_ads.update_campaign_budget' then
    v_platform := 'meta'; v_object := v_dec.body->>'campaign_id';
  else
    return jsonb_build_object('status', 'not_a_raise');
  end if;
  if v_platform = 'meta' and coalesce(nullif(upper(btrim(v_dec.body->>'currency')), ''), 'USD') <> 'USD' then
    return jsonb_build_object('status', 'not_a_raise');
  end if;
  if coalesce(jsonb_typeof(v_dec.body->'daily_budget_usd'), '') <> 'number'
     or coalesce(jsonb_typeof(v_dec.body->'expected_current_daily_budget_usd'), '') <> 'number'
     or v_object is null or btrim(v_object) = '' then
    return jsonb_build_object('status', 'changed');
  end if;
  v_delta := ceil(((v_dec.body->>'daily_budget_usd')::numeric - (v_dec.body->>'expected_current_daily_budget_usd')::numeric) * 100) / 100;
  if not (v_delta > 0 and v_delta < 1000000) then
    return jsonb_build_object('status', 'not_a_raise');
  end if;
  if v_object is distinct from p_expected_object_id
     or p_expected_daily_delta_usd is null
     or abs(v_delta - ceil(p_expected_daily_delta_usd * 100) / 100) > 0.004 then
    return jsonb_build_object('status', 'changed');
  end if;

  if v_dec.status <> 'proposed' then
    if v_dec.status in ('approved', 'dispatching', 'acted') and exists (
      select 1 from ad_budget_reservations where budget_id = v_budget.id and idem_key = v_idem) then
      return jsonb_build_object('status', 'approved', 'changed', false, 'decision_status', v_dec.status);
    end if;
    return jsonb_build_object('status', 'decision_closed', 'decision_status', v_dec.status);
  end if;

  if _ad_month_token(p_tenant_id) is distinct from p_token then
    return jsonb_build_object('status', 'stale');
  end if;

  v_monthly := greatest(v_budget.monthly_usd, coalesce(round(p_monthly_to, 2), 0));
  v_daily := case when v_budget.daily_limit_usd is null then null
                  else greatest(v_budget.daily_limit_usd, coalesce(round(p_daily_limit_to, 2), 0)) end;
  if v_daily is not null and v_daily > v_monthly then
    return jsonb_build_object('status', 'daily_above_monthly', 'daily_limit_usd', v_daily, 'monthly_usd', v_monthly);
  end if;

  if exists (select 1 from ad_budget_reservations
              where budget_id = v_budget.id and platform = v_platform and object_id = v_object
                and status = 'reserved' and idem_key <> v_idem) then
    return jsonb_build_object('status', 'object_busy');
  end if;
  select coalesce(sum(daily_delta_usd), 0) into v_live from ad_budget_reservations
   where budget_id = v_budget.id and status in ('reserved', 'committed') and idem_key <> v_idem;
  if v_daily is not null and v_live + v_delta > v_daily then
    return jsonb_build_object('status', 'over_daily_limit', 'live_daily_usd', v_live, 'daily_limit_usd', v_daily);
  end if;

  v_amt := ceil(v_delta * _ad_budget_days_left(v_today) * v_budget.margin * 100) / 100;
  select id into v_own from ad_budget_reservations where budget_id = v_budget.id and idem_key = v_idem;
  v_cap := _ad_budget_month_cap(v_monthly, v_budget.started_on, v_today);
  v_used := _ad_budget_spent_usd(v_budget.spent_usd, v_budget.month_start, v_today)
          + _ad_budget_held_usd(v_budget.id, v_today, v_budget.margin, v_own)
          + _creator_hire_used_usd(v_budget.id, v_today);
  if v_used + v_amt > v_cap then
    return jsonb_build_object('status', 'over_month', 'used_usd', v_used, 'hold_usd', v_amt, 'month_cap_usd', v_cap);
  end if;

  if v_monthly is distinct from v_budget.monthly_usd or v_daily is distinct from v_budget.daily_limit_usd then
    v_edit := update_ad_budget(p_tenant_id, p_actor_user_id, v_budget.id, v_monthly, v_daily);
    if coalesce(v_edit->>'status', '') <> 'updated' then
      return v_edit || jsonb_build_object('status', 'limits_' || coalesce(v_edit->>'status', 'failed'));
    end if;
    select * into v_budget from ad_budgets where id = v_budget.id;
  end if;

  insert into ad_budget_reservations (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, decision_id)
  values (v_budget.id, p_tenant_id, v_idem, v_platform, v_object, 'raise', v_delta, v_amt, p_decision_id)
  on conflict (budget_id, idem_key) do nothing
  returning * into v_res;
  if not found then
    update ad_budget_reservations
       set daily_delta_usd = v_delta, amount_usd = v_amt, released_on = null, pause_due = false,
           bounded = false, ends_on = null, cap_usd = null, hold_factor = null, spend_from = null,
           over_cap = false, paused = false, object_id = v_object, status = 'reserved', reason = null,
           decision_id = coalesce(decision_id, p_decision_id), updated_at = now()
     where budget_id = v_budget.id and idem_key = v_idem and status in ('refused', 'released');
  end if;

  update decisions
     set body = coalesce(body, '{}'::jsonb) || jsonb_build_object('budget_choice', jsonb_build_object(
           'hold_idem', v_idem, 'at', now(), 'monthly_usd', v_budget.monthly_usd, 'daily_limit_usd', v_budget.daily_limit_usd))
   where id = p_decision_id;

  v_flip := decide_decision_as_actor(p_decision_id, p_tenant_id, p_actor_user_id, 'approve');
  if coalesce((v_flip->>'changed')::boolean, false) is not true then
    raise exception 'approve_ad_raise_with_budget: the decision did not flip (%)', v_flip;
  end if;

  update ad_budgets set updated_at = now() where id = v_budget.id;
  return jsonb_build_object('status', 'approved', 'changed', true, 'monthly_usd', v_budget.monthly_usd,
    'daily_limit_usd', v_budget.daily_limit_usd, 'hold_usd', v_amt);
end $$;

revoke all on function public._ad_row_can_spend(text, text) from public, anon, authenticated;
revoke all on function public._ad_stale_accounts(uuid) from public, anon, authenticated;
revoke all on function public._ad_month_token(uuid) from public, anon, authenticated;
revoke all on function public.ad_month_token(uuid) from public, anon, authenticated;
revoke all on function public.approve_ad_raise_with_budget(uuid, uuid, uuid, text, text, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public._ad_row_can_spend(text, text) to service_role;
grant execute on function public._ad_stale_accounts(uuid) to service_role;
grant execute on function public._ad_month_token(uuid) to service_role;
grant execute on function public.ad_month_token(uuid) to service_role;
grant execute on function public.approve_ad_raise_with_budget(uuid, uuid, uuid, text, text, numeric, numeric, numeric) to service_role;

commit;
