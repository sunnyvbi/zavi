begin;
alter table public.ad_budget_reservations drop constraint ad_budget_reservations_platform_check;
alter table public.ad_budget_reservations add constraint ad_budget_reservations_platform_check check (platform in ('meta', 'google', 'chatgpt'));
alter table public.ad_campaigns drop constraint ad_campaigns_platform_check;
alter table public.ad_campaigns add constraint ad_campaigns_platform_check check (platform in ('meta', 'google', 'reddit', 'tiktok', 'chatgpt'));
alter table public.ad_spend_daily drop constraint ad_spend_daily_platform_check;
alter table public.ad_spend_daily add constraint ad_spend_daily_platform_check check (platform in ('meta', 'google', 'reddit', 'tiktok', 'chatgpt'));
alter table public.ad_budget_plan drop constraint ad_budget_plan_platform_check;
alter table public.ad_budget_plan add constraint ad_budget_plan_platform_check check (platform in ('meta', 'google', 'reddit', 'tiktok', 'chatgpt'));
alter table public.ad_object_changes drop constraint ad_object_changes_platform_check;
alter table public.ad_object_changes add constraint ad_object_changes_platform_check check (platform in ('meta', 'google', 'chatgpt'));

create or replace function public.reserve_ad_spend(
  p_tenant_id       uuid,
  p_idem_key        text,
  p_platform        text,
  p_op              text,
  p_object_id       text,
  p_daily_delta_usd numeric,
  p_channel_action_id uuid default null,
  p_decision_id       uuid default null,
  p_paused            boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget   ad_budgets%rowtype;
  v_res      ad_budget_reservations%rowtype;
  v_today    date;
  v_delta    numeric(12,2);
  v_amt      numeric(12,2);
  v_cap      numeric(12,2);
  v_reason   text;
  v_updated  uuid;
  v_unpause  numeric(12,2) := 0;
  v_extra    numeric(12,2) := 0;
begin
  if p_tenant_id is null or p_idem_key is null or btrim(p_idem_key) = '' then
    raise exception 'reserve_ad_spend: tenant and idem_key are required';
  end if;
  if p_platform is null or p_platform not in ('meta', 'google', 'chatgpt') then
    raise exception 'reserve_ad_spend: invalid platform %', p_platform;
  end if;
  if p_op is null or p_op not in ('raise', 'resume', 'create') then
    raise exception 'reserve_ad_spend: invalid op %', p_op;
  end if;
  if p_daily_delta_usd is null or not (p_daily_delta_usd >= 0 and p_daily_delta_usd < 1000000) then
    raise exception 'reserve_ad_spend: invalid daily delta';
  end if;
  if p_channel_action_id is not null and not exists (
    select 1 from channel_actions where id = p_channel_action_id and tenant_id = p_tenant_id
  ) then
    raise exception 'reserve_ad_spend: channel action not found for tenant';
  end if;
  if p_decision_id is not null and not exists (
    select 1 from decisions where id = p_decision_id and tenant_id = p_tenant_id
  ) then
    raise exception 'reserve_ad_spend: decision not found for tenant';
  end if;

  select * into v_budget from ad_budgets
   where tenant_id = p_tenant_id and status = 'active'
   for update;
  if not found then
    return jsonb_build_object('status', 'no_budget', 'amount_usd', 0, 'reason', null);
  end if;

  v_today := _ad_budget_today();

  if p_op in ('raise', 'resume')
     and exists (
       select 1 from ad_budget_reservations
        where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
          and status = 'reserved' and idem_key <> p_idem_key)
     and not exists (
       select 1 from ad_budget_reservations
        where budget_id = v_budget.id and idem_key = p_idem_key
          and status in ('reserved', 'committed')) then
    return jsonb_build_object('status', 'refused', 'amount_usd', 0, 'reason', 'object_busy');
  end if;

  v_delta := ceil(p_daily_delta_usd * case when p_platform = 'chatgpt' then 2 else 1 end * 100) / 100;
  if p_op = 'resume' then
    v_delta := greatest(v_delta - coalesce((
      select sum(daily_delta_usd) from ad_budget_reservations
       where budget_id = v_budget.id and platform = p_platform
         and object_id = p_object_id and status in ('reserved', 'committed')
         and not pause_due
    ), 0), 0);
  end if;
  v_amt := ceil(v_delta * _ad_budget_days_left(v_today) * v_budget.margin * 100) / 100;
  if p_paused and p_op = 'create' then
    v_amt := ceil(v_delta * v_budget.margin * 100) / 100;
  end if;
  if p_op = 'resume' then
    select coalesce(sum(daily_delta_usd), 0) into v_unpause from ad_budget_reservations
     where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
       and status in ('reserved', 'committed') and paused and not pause_due
       and idem_key <> p_idem_key;
    v_extra := ceil(v_unpause * greatest(_ad_budget_days_left(v_today) - 1, 0) * v_budget.margin * 100) / 100;
    v_amt := v_amt + v_extra;
  end if;
  v_cap := _ad_budget_month_cap(v_budget.monthly_usd, v_budget.started_on, v_today);

  insert into ad_budget_reservations
    (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd)
  values
    (v_budget.id, p_tenant_id, p_idem_key, p_platform, p_object_id, p_op, v_delta, v_amt)
  on conflict (budget_id, idem_key) do nothing
  returning * into v_res;

  if not found then
    select * into v_res from ad_budget_reservations
     where budget_id = v_budget.id and idem_key = p_idem_key
     for update;
    if v_res.status in ('reserved', 'committed') then
      return jsonb_build_object('status', 'already_held', 'amount_usd', v_res.amount_usd, 'reason', null,
        'month_cap_usd', v_cap);
    end if;
    update ad_budget_reservations
       set daily_delta_usd = v_delta, amount_usd = v_amt, released_on = null, pause_due = false,
           object_id = coalesce(p_object_id, object_id),
           status = 'reserved', reason = null, updated_at = now()
     where id = v_res.id
     returning * into v_res;
  end if;

  if p_channel_action_id is not null or p_decision_id is not null then
    update ad_budget_reservations
       set channel_action_id = coalesce(channel_action_id, p_channel_action_id),
           decision_id = coalesce(decision_id, p_decision_id)
     where id = v_res.id;
  end if;

  update ad_budget_reservations
     set paused = (p_paused and p_op = 'create')
   where id = v_res.id and paused is distinct from (p_paused and p_op = 'create');

  if v_delta = 0 and v_extra = 0 then
    if v_unpause > 0 then
      update ad_budget_reservations set paused = false, updated_at = now()
       where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
         and status in ('reserved', 'committed') and paused and not pause_due and idem_key <> p_idem_key;
    end if;
    return jsonb_build_object('status', 'held', 'amount_usd', v_amt, 'reason', null, 'month_cap_usd', v_cap);
  end if;

  update ad_budgets
     set updated_at = now()
   where id = v_budget.id
     and status = 'active'
     and _ad_budget_spent_usd(spent_usd, month_start, v_today)
         + _ad_budget_held_usd(v_budget.id, v_today, margin, v_res.id)
         + _creator_hire_used_usd(v_budget.id, v_today)
         + v_amt <= v_cap
     and (daily_limit_usd is null or coalesce((
           select sum(x.daily_delta_usd) from ad_budget_reservations x
            where x.budget_id = v_budget.id and x.id <> v_res.id
              and x.status in ('reserved', 'committed')
         ), 0) + v_delta <= daily_limit_usd)
  returning id into v_updated;
  if v_updated is not null then
    if v_unpause > 0 then
      update ad_budget_reservations set paused = false, updated_at = now()
       where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
         and status in ('reserved', 'committed') and paused and not pause_due and idem_key <> p_idem_key;
    end if;
    return jsonb_build_object('status', 'held', 'amount_usd', v_amt, 'reason', null, 'month_cap_usd', v_cap);
  end if;

  v_reason := case
    when v_budget.daily_limit_usd is not null and coalesce((
           select sum(x.daily_delta_usd) from ad_budget_reservations x
            where x.budget_id = v_budget.id and x.id <> v_res.id
              and x.status in ('reserved', 'committed')
         ), 0) + v_delta > v_budget.daily_limit_usd
      then 'over_daily_limit'
    else 'over_month'
  end;
  update ad_budget_reservations
     set status = 'refused', reason = v_reason, updated_at = now()
   where id = v_res.id;
  return jsonb_build_object('status', 'refused', 'amount_usd', v_amt, 'reason', v_reason);
end $$;

create or replace function public.rebase_ad_spend_for_object(
  p_tenant_id     uuid,
  p_platform      text,
  p_object_id     text,
  p_new_daily_usd numeric,
  p_idem_key      text,
  p_cut_usd       numeric default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_today  date;
  v_new    numeric(12,2);
  v_held   numeric(12,2);
  v_paused boolean;
  v_mixed  boolean;
begin
  if p_tenant_id is null or p_object_id is null or btrim(p_object_id) = ''
     or p_idem_key is null or btrim(p_idem_key) = '' then
    raise exception 'rebase_ad_spend_for_object: tenant, object and idem_key are required';
  end if;
  if p_platform is null or p_platform not in ('meta', 'google', 'chatgpt') then
    raise exception 'rebase_ad_spend_for_object: invalid platform %', p_platform;
  end if;
  if p_new_daily_usd is null or not (p_new_daily_usd >= 0 and p_new_daily_usd < 1000000) then
    raise exception 'rebase_ad_spend_for_object: invalid daily amount';
  end if;
  if p_cut_usd is not null and not (p_cut_usd > 0 and p_cut_usd < 1000000) then
    raise exception 'rebase_ad_spend_for_object: invalid cut amount';
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
  select bool_and(paused), bool_or(paused) and not bool_and(paused) into v_paused, v_mixed
    from ad_budget_reservations
   where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
     and status = 'committed';
  if v_mixed then
    return jsonb_build_object('status', 'not_lower', 'daily_usd', v_held);
  end if;

  v_new := ceil(p_new_daily_usd * case when p_platform = 'chatgpt' then 2 else 1 end * 100) / 100;
  if p_cut_usd is not null and not exists (
       select 1 from ad_budget_reservations
        where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
          and status = 'committed' and idem_key like 'shrink:%') then
    v_new := greatest(v_held - floor(p_cut_usd * case when p_platform = 'chatgpt' then 2 else 1 end * 100) / 100, 0);
  end if;
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
  if v_paused then
    update ad_budget_reservations
       set paused = true, amount_usd = ceil(v_new * v_budget.margin * 100) / 100
     where budget_id = v_budget.id and idem_key = p_idem_key;
  end if;

  return jsonb_build_object('status', 'rebased', 'daily_usd', v_new, 'released_daily_usd', v_held);
end $$;

create or replace function public.record_ad_ledger_read(
  p_tenant_id  uuid,
  p_platform   text,
  p_account_id text,
  p_campaigns  jsonb,
  p_spend      jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_campaigns int;
  v_spend     int;
begin
  if p_tenant_id is null then
    raise exception 'record_ad_ledger_read: tenant is required' using errcode = '22023';
  end if;
  if p_platform is null or p_platform not in ('meta', 'google', 'reddit', 'tiktok', 'chatgpt') then
    raise exception 'record_ad_ledger_read: invalid platform' using errcode = '22023';
  end if;
  if p_account_id is null or char_length(p_account_id) not between 1 and 64 then
    raise exception 'record_ad_ledger_read: invalid account' using errcode = '22023';
  end if;
  if p_campaigns is null or jsonb_typeof(p_campaigns) <> 'array' or jsonb_array_length(p_campaigns) > 50000
     or p_spend is null or jsonb_typeof(p_spend) <> 'array' or jsonb_array_length(p_spend) > 200000 then
    raise exception 'record_ad_ledger_read: campaigns and spend must be arrays of a sane size' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_campaigns) e
     where jsonb_typeof(e) <> 'object'
        or coalesce(char_length(e->>'object_id'), 0) not between 1 and 64
        or coalesce(char_length(e->>'campaign_id'), 0) > 64
        or coalesce(char_length(e->>'status'), 0) > 64
        or (e->>'budget_usd' is not null and not ((e->>'budget_usd')::numeric >= 0 and (e->>'budget_usd')::numeric < 1000000000))
        or (e->>'campaign_budget_usd' is not null and not ((e->>'campaign_budget_usd')::numeric >= 0 and (e->>'campaign_budget_usd')::numeric < 1000000000))
  ) then
    raise exception 'record_ad_ledger_read: invalid campaign row' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_spend) e
     where jsonb_typeof(e) <> 'object'
        or coalesce(char_length(e->>'object_id'), 0) not between 1 and 64
        or coalesce(e->>'spend_date', '') !~ '^\d{4}-\d{2}-\d{2}$'
        or e->>'amount_usd' is null
        or not ((e->>'amount_usd')::numeric >= 0 and (e->>'amount_usd')::numeric < 1000000000)
  ) then
    raise exception 'record_ad_ledger_read: invalid spend row' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_spend) e
     where (e->>'spend_date')::date not between date '2020-01-01' and _ad_budget_today() + 2
  ) then
    raise exception 'record_ad_ledger_read: spend date out of range' using errcode = '22023';
  end if;

  insert into ad_campaigns (tenant_id, platform, account_id, object_id, level, campaign_id, name,
                            budget_kind, budget_usd, campaign_budget_usd, status, currency, source, as_of, updated_at)
  select distinct on (e.value->>'object_id')
         p_tenant_id, p_platform, p_account_id, e.value->>'object_id', e.value->>'level',
         nullif(e.value->>'campaign_id', ''), left(e.value->>'name', 500),
         e.value->>'budget_kind', round((e.value->>'budget_usd')::numeric, 2),
         round((e.value->>'campaign_budget_usd')::numeric, 2),
         e.value->>'status', upper(e.value->>'currency'), 'api', now(), now()
    from jsonb_array_elements(p_campaigns) with ordinality e(value, n)
   order by e.value->>'object_id', e.n desc
  on conflict (tenant_id, platform, account_id, object_id) do update
     set level = excluded.level, campaign_id = excluded.campaign_id, name = excluded.name,
         budget_kind = excluded.budget_kind, budget_usd = excluded.budget_usd,
         campaign_budget_usd = excluded.campaign_budget_usd,
         status = excluded.status, currency = excluded.currency, source = excluded.source,
         as_of = excluded.as_of, updated_at = now();
  get diagnostics v_campaigns = row_count;

  update ad_campaigns c
     set status = 'removed', as_of = now(), updated_at = now()
   where c.tenant_id = p_tenant_id and c.platform = p_platform and c.account_id = p_account_id
     and c.source = 'api' and c.status is distinct from 'removed'
     and not exists (select 1 from jsonb_array_elements(p_campaigns) e
                      where e->>'object_id' = c.object_id);

  insert into ad_spend_daily (tenant_id, platform, account_id, object_id, spend_date, amount_usd,
                              source, recorded_at, provisional)
  select p_tenant_id, p_platform, p_account_id, e->>'object_id', (e->>'spend_date')::date,
         sum(round((e->>'amount_usd')::numeric, 2)), 'api', now(),
         bool_or(coalesce((e->>'provisional')::boolean, false))
    from jsonb_array_elements(p_spend) e
   group by e->>'object_id', (e->>'spend_date')::date
  on conflict (tenant_id, platform, account_id, object_id, spend_date, source) do update
     set amount_usd = excluded.amount_usd, recorded_at = excluded.recorded_at,
         provisional = excluded.provisional;
  get diagnostics v_spend = row_count;

  return jsonb_build_object('status', 'recorded', 'campaigns', v_campaigns, 'spend_rows', v_spend);
end $$;

create or replace function public.record_ad_object_changes(
  p_tenant_id uuid,
  p_changes   jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  if p_tenant_id is null then
    raise exception 'record_ad_object_changes: tenant is required' using errcode = '22023';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 500 then
    raise exception 'record_ad_object_changes: changes must be an array of at most 500' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_changes) e
     where jsonb_typeof(e) <> 'object'
        or coalesce(e->>'platform', '') not in ('meta', 'google', 'chatgpt')
        or coalesce(char_length(e->>'object_id'), 0) not between 1 and 64
        or coalesce(e->>'source', '') not in ('zavi', 'outside')
        or coalesce(e->>'change_kind', '') not in ('status', 'budget')
        or (e->>'level' is not null and e->>'level' not in ('ad_set', 'campaign'))
        or coalesce(char_length(e->>'campaign_id'), 0) > 64
        or coalesce(char_length(e->>'before_status'), 0) > 64
        or coalesce(char_length(e->>'after_status'), 0) > 64
        or (e->>'before_daily_usd' is not null and not ((e->>'before_daily_usd')::numeric >= 0 and (e->>'before_daily_usd')::numeric < 1000000000))
        or (e->>'after_daily_usd' is not null and not ((e->>'after_daily_usd')::numeric >= 0 and (e->>'after_daily_usd')::numeric < 1000000000))
        or ((e->>'source') = 'zavi') <> (e->>'action_table' is not null)
        or (e->>'action_table' is not null and e->>'action_table' not in ('channel_actions', 'decisions', 'budget_stop'))
        or (e->>'action_table' in ('channel_actions', 'decisions') and e->>'action_id' is null)
  ) then
    raise exception 'record_ad_object_changes: invalid change row' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_changes) e
     where (e->>'action_table' = 'channel_actions'
            and not exists (select 1 from channel_actions a
                             where a.id = (e->>'action_id')::uuid and a.tenant_id = p_tenant_id))
        or (e->>'action_table' = 'decisions'
            and not exists (select 1 from decisions d
                             where d.id = (e->>'action_id')::uuid and d.tenant_id = p_tenant_id))
  ) then
    raise exception 'record_ad_object_changes: action not found for this tenant' using errcode = '22023';
  end if;

  insert into ad_object_changes (tenant_id, platform, object_id, level, campaign_id, object_name, source,
                                 action_table, action_id, change_kind, before_status, after_status,
                                 before_daily_usd, after_daily_usd, occurred_at)
  select p_tenant_id, e->>'platform', e->>'object_id', e->>'level', nullif(e->>'campaign_id', ''),
         left(e->>'object_name', 500), e->>'source', e->>'action_table', (e->>'action_id')::uuid,
         e->>'change_kind', e->>'before_status', e->>'after_status',
         round((e->>'before_daily_usd')::numeric, 2), round((e->>'after_daily_usd')::numeric, 2), now()
    from jsonb_array_elements(p_changes) e
  on conflict (tenant_id, action_table, action_id, object_id, change_kind) do nothing;
  get diagnostics v_n = row_count;

  return jsonb_build_object('status', 'recorded', 'inserted', v_n);
end $$;

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
     or (p_ref->>'kind') not in ('meta_tag', 'meta_adset_name', 'google_campaign_name', 'chatgpt_campaign_name') then
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

alter table public.tenant_channels add column chatgpt_autopilot_consent_at timestamptz;
create function public.set_chatgpt_autopilot(p_tenant_id uuid, p_actor_user_id uuid, p_enabled boolean)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_enabled is null or not exists (
   select 1 from tenant_users where tenant_id=p_tenant_id and user_id=p_actor_user_id and role in ('owner','admin')
 ) then return false; end if;
 if not set_channel_autorun(p_tenant_id,'chatgpt_ads',p_enabled) then return false; end if;
 update tenant_channels set chatgpt_autopilot_consent_at=case when p_enabled then now() else null end
  where tenant_id=p_tenant_id and channel_slug='chatgpt_ads' and autorun is not distinct from p_enabled;
 return found;
end $$;
revoke all on function public.set_chatgpt_autopilot(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.set_chatgpt_autopilot(uuid,uuid,boolean) to service_role;

insert into public.decision_classes(slug,description,default_autonomy,dispatch_handler,never_auto) values
 ('chatgpt_ads.create_and_launch','Create and launch a bounded ChatGPT campaign','approval','chatgpt_ads.create_and_launch',true),
 ('chatgpt_ads.update_campaign_budget','Change a ChatGPT daily budget','approval','chatgpt_ads.update_campaign_budget',true),
 ('chatgpt_ads.set_status','Launch or pause a ChatGPT campaign','approval','chatgpt_ads.set_status',true)
on conflict (slug) do nothing;
create or replace function public.shrink_underdelivering_ad_holds(p_tenant_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_today  date;
  v_o      record;
  v_r      jsonb;
  v_n      int := 0;
begin
  if p_tenant_id is null then
    raise exception 'shrink_underdelivering_ad_holds: tenant is required';
  end if;

  select * into v_budget from ad_budgets
   where tenant_id = p_tenant_id and status = 'active'
   for update;
  if not found then
    return jsonb_build_object('status', 'no_budget', 'shrunk', 0);
  end if;
  if v_budget.actual_read_at is null or v_budget.actual_read_at < now() - interval '3 hours' then
    return jsonb_build_object('status', 'stale', 'shrunk', 0);
  end if;

  v_today := _ad_budget_today();
  for v_o in
    with obj as (
      select r.platform, r.object_id,
             sum(r.daily_delta_usd) filter (where r.status = 'committed') as held,
             max(greatest(r.created_at, r.updated_at)) as last_change
        from ad_budget_reservations r
       where r.budget_id = v_budget.id and r.tenant_id = p_tenant_id
         and r.platform <> 'chatgpt'
         and r.status in ('reserved', 'committed') and r.object_id is not null
       group by r.platform, r.object_id
      having not bool_or(r.status = 'reserved') and not bool_or(r.paused) and not bool_or(r.pause_due)
    ), sets as (
      select distinct c.platform, c.object_id, c.campaign_id
        from ad_campaigns c
       where c.tenant_id = p_tenant_id and c.platform = 'meta' and c.level = 'ad_set' and c.campaign_id is not null
         and c.as_of >= now() - interval '3 hours'
         and not exists (
           select 1 from ad_campaigns x
            where x.tenant_id = p_tenant_id and x.platform = c.platform and x.object_id = c.campaign_id)
    ), led as (
      select c.platform, c.object_id,
             max(c.budget_usd) filter (where c.budget_kind = 'daily') as daily_budget,
             bool_and(c.as_of >= now() - interval '3 hours'
                      and upper(coalesce(c.status, '')) in ('ACTIVE', 'ENABLED')) as on_fresh
        from ad_campaigns c
       where c.tenant_id = p_tenant_id
       group by c.platform, c.object_id
      union all
      select c.platform, c.campaign_id, max(c.campaign_budget_usd),
             bool_or(upper(coalesce(c.status, '')) in ('ACTIVE', 'ENABLED'))
        from ad_campaigns c
       where c.tenant_id = p_tenant_id and c.platform = 'meta' and c.level = 'ad_set' and c.campaign_id is not null
         and c.as_of >= now() - interval '3 hours'
         and not exists (
           select 1 from ad_campaigns x
            where x.tenant_id = p_tenant_id and x.platform = c.platform and x.object_id = c.campaign_id)
       group by c.platform, c.campaign_id
    ), day as (
      select s.platform, s.object_id, s.spend_date, max(s.amount_usd) as amt
        from ad_spend_daily s
       where s.tenant_id = p_tenant_id and s.spend_date between v_today - 3 and v_today - 1
       group by s.platform, s.object_id, s.spend_date
    ), spend as (
      select d.platform, d.object_id, sum(d.amt) / 3.0 as trailing
        from day d
       group by d.platform, d.object_id
      union all
      select d.platform, st.campaign_id, sum(d.amt) / 3.0
        from day d
        join sets st on st.platform = d.platform and st.object_id = d.object_id
       group by d.platform, st.campaign_id
    )
    select o.platform, o.object_id, o.held,
           coalesce(nullif(l.daily_budget, 0), o.held) as daily_budget,
           coalesce(s.trailing, 0) as trailing
      from obj o
      join led l on l.platform = o.platform and l.object_id = o.object_id and l.on_fresh
      left join spend s on s.platform = o.platform and s.object_id = o.object_id
     where o.held > 0 and o.last_change < now() - interval '72 hours'
  loop
    if v_o.trailing < 0.7 * v_o.daily_budget then
      v_r := rebase_ad_spend_for_object(p_tenant_id, v_o.platform, v_o.object_id,
               ceil(v_o.trailing * 1.2 * 100) / 100,
               'shrink:' || v_o.platform || ':' || v_o.object_id || ':' || v_today::text);
      if v_r->>'status' = 'rebased' then
        v_n := v_n + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('status', 'done', 'shrunk', v_n);
end $$;

create or replace function public.release_idle_ad_holds(p_tenant_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_today  date;
  v_whole  boolean;
  v_n      int;
  v_daily  numeric(12,2);
begin
  if p_tenant_id is null then
    raise exception 'release_idle_ad_holds: tenant is required';
  end if;

  select * into v_budget from ad_budgets
   where tenant_id = p_tenant_id and status = 'active'
   for update;
  if not found then
    return jsonb_build_object('status', 'no_budget', 'released', 0, 'released_daily_usd', 0);
  end if;

  v_today := _ad_budget_today();
  v_whole := v_budget.actual_read_at is not null and v_budget.actual_read_at > now() - interval '3 hours';
  if not v_whole then
    return jsonb_build_object('status', 'stale', 'released', 0, 'released_daily_usd', 0);
  end if;

  with obj as (
    select r.platform, r.object_id,
           bool_and(r.paused) as all_paused,
           bool_or(r.status = 'reserved') as in_flight,
           max(greatest(r.created_at, r.updated_at)) as last_change
      from ad_budget_reservations r
     where r.budget_id = v_budget.id and r.tenant_id = p_tenant_id
       and r.status in ('reserved', 'committed') and r.object_id is not null
     group by r.platform, r.object_id
  ), led as (
    select c.platform, c.object_id,
           bool_and(upper(coalesce(c.status, '')) = 'REMOVED'
                    or (c.as_of >= now() - interval '3 hours'
                        and upper(coalesce(c.status, '')) in
                            ('PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED', 'REMOVED', 'ENDED'))) as paused_fresh
      from ad_campaigns c
     where c.tenant_id = p_tenant_id
     group by c.platform, c.object_id
    union all
    select c.platform, c.campaign_id,
           bool_and(upper(coalesce(c.status, '')) in
                        ('PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED', 'REMOVED', 'ENDED'))
      from ad_campaigns c
     where c.tenant_id = p_tenant_id and c.platform = 'meta' and c.level = 'ad_set' and c.campaign_id is not null
       and (c.as_of >= now() - interval '3 hours' or upper(coalesce(c.status, '')) = 'REMOVED')
       and not exists (
         select 1 from ad_campaigns x
          where x.tenant_id = p_tenant_id and x.platform = c.platform and x.object_id = c.campaign_id)
     group by c.platform, c.campaign_id
  ), spent as (
    select s.platform, s.object_id
      from ad_spend_daily s
     where s.tenant_id = p_tenant_id and s.spend_date >= v_today - 2 and s.amount_usd > 0
    union
    select s.platform, c.campaign_id
      from ad_spend_daily s
      join ad_campaigns c on c.tenant_id = p_tenant_id and c.platform = s.platform and c.object_id = s.object_id
     where s.tenant_id = p_tenant_id and s.platform = 'meta' and c.campaign_id is not null
       and s.spend_date >= v_today - 2 and s.amount_usd > 0
  ), idle as (
    select o.platform, o.object_id
      from obj o
      left join led l on l.platform = o.platform and l.object_id = o.object_id
     where not o.in_flight
       and o.last_change < now() - interval '48 hours'
       and not exists (select 1 from spent s where s.platform = o.platform and s.object_id = o.object_id)
       and (
         l.paused_fresh is true
         or (l.object_id is null and o.all_paused)
       )
  ), rel as (
    update ad_budget_reservations r
       set status = 'released', released_on = v_today, reason = 'idle_paused',
           pause_due = false, updated_at = now()
      from idle i
     where r.budget_id = v_budget.id and r.tenant_id = p_tenant_id
       and r.platform = i.platform and r.object_id = i.object_id and r.status = 'committed'
    returning r.daily_delta_usd
  )
  select count(*), coalesce(sum(daily_delta_usd), 0) into v_n, v_daily from rel;

  return jsonb_build_object('status', 'done', 'released', v_n, 'released_daily_usd', v_daily);
end $$;

revoke all on function public.reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.rebase_ad_spend_for_object(uuid, text, text, numeric, text, numeric) from public, anon, authenticated;
revoke all on function public.record_ad_ledger_read(uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.record_ad_object_changes(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.note_ad_spend_ref(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.shrink_underdelivering_ad_holds(uuid) from public, anon, authenticated;
revoke all on function public.release_idle_ad_holds(uuid) from public, anon, authenticated;
grant execute on function public.reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid, boolean) to service_role;
grant execute on function public.rebase_ad_spend_for_object(uuid, text, text, numeric, text, numeric) to service_role;
grant execute on function public.record_ad_ledger_read(uuid, text, text, jsonb, jsonb) to service_role;
grant execute on function public.record_ad_object_changes(uuid, jsonb) to service_role;
grant execute on function public.note_ad_spend_ref(uuid, text, jsonb) to service_role;
grant execute on function public.shrink_underdelivering_ad_holds(uuid) to service_role;
grant execute on function public.release_idle_ad_holds(uuid) to service_role;

commit;
