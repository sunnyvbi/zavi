
update system_config
set blob = jsonb_set(blob, '{ads_autopilot_self_serve_max_usd}', '500'::jsonb, true),
    updated_at = now()
where id = 1
  and not (blob ? 'ads_autopilot_self_serve_max_usd');

update decision_classes
   set never_auto = true
 where slug in ('meta_ads.set_status_review', 'google_ads.set_status_review');

create or replace function set_tenant_ads_autopilot(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_platform text,
  p_enabled boolean,
  p_max_daily_budget_usd numeric
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_ceiling numeric;
  v_budget_class text;
begin
  if p_tenant_id is null or p_actor_user_id is null or p_platform is null then
    return jsonb_build_object('ok', false, 'reason', 'not_owner');
  end if;
  if p_platform not in ('meta_ads', 'google_ads') then
    return jsonb_build_object('ok', false, 'reason', 'bad_platform');
  end if;

  select role into v_role
  from tenant_users
  where user_id = p_actor_user_id and tenant_id = p_tenant_id;
  if v_role is null or v_role not in ('owner', 'admin') then
    return jsonb_build_object('ok', false, 'reason', 'not_owner');
  end if;

  if p_enabled is true then
    if p_max_daily_budget_usd is null or p_max_daily_budget_usd <= 0 then
      return jsonb_build_object('ok', false, 'reason', 'bad_budget');
    end if;
    select coalesce((blob->>'ads_autopilot_self_serve_max_usd')::numeric, 500)
      into v_ceiling
    from system_config where id = 1;
    v_ceiling := coalesce(v_ceiling, 500);
    if p_max_daily_budget_usd > v_ceiling then
      return jsonb_build_object('ok', false, 'reason', 'over_self_serve_max', 'max', v_ceiling);
    end if;
  end if;

  insert into tenant_ads_write_caps (
    tenant_id, platform, enabled, max_daily_budget_usd,
    max_pct_change_per_run, max_daily_total_change_usd, updated_at
  ) values (
    p_tenant_id,
    p_platform,
    p_enabled,
    case when p_enabled then p_max_daily_budget_usd else null end,
    case when p_enabled then 0.50 else null end,
    case when p_enabled then 2 * p_max_daily_budget_usd else null end,
    now()
  )
  on conflict (tenant_id, platform)
  do update set
    enabled = excluded.enabled,
    max_daily_budget_usd = excluded.max_daily_budget_usd,
    max_pct_change_per_run = excluded.max_pct_change_per_run,
    max_daily_total_change_usd = excluded.max_daily_total_change_usd,
    updated_at = now();

  if p_enabled is true then
    v_budget_class := case p_platform
      when 'meta_ads'   then 'meta_ads.update_ad_set_budget'
      when 'google_ads' then 'google_ads.update_campaign_budget'
    end;
    delete from tenant_decision_class_overrides
    where tenant_id = p_tenant_id
      and decision_class = v_budget_class
      and autonomy in ('approval'::decision_autonomy, 'forbidden'::decision_autonomy);
  end if;

  return jsonb_build_object('ok', true);
end $$;
revoke all on function set_tenant_ads_autopilot(uuid, uuid, text, boolean, numeric) from public;
revoke all on function set_tenant_ads_autopilot(uuid, uuid, text, boolean, numeric) from authenticated;
grant execute on function set_tenant_ads_autopilot(uuid, uuid, text, boolean, numeric) to service_role;
