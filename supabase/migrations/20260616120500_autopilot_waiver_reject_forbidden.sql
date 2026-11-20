
begin;

create or replace function grant_autopilot_waiver(
  p_tenant_id              uuid,
  p_decision_class         text,
  p_expires_at             timestamptz,
  p_max_daily_usd          numeric,
  p_cooling_off_seconds    int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := now();
  v_max_expiry timestamptz := v_now + interval '7 days';
  v_never_auto boolean;
  v_default_autonomy decision_autonomy;
begin
  if p_tenant_id is null or p_decision_class is null or p_expires_at is null then
    raise exception 'grant_autopilot_waiver: tenant_id, decision_class, expires_at are required'
      using errcode = '22023';
  end if;

  select never_auto, default_autonomy
    into v_never_auto, v_default_autonomy
  from decision_classes where slug = p_decision_class;

  if v_never_auto is true or v_default_autonomy = 'forbidden'::decision_autonomy then
    raise exception 'grant_autopilot_waiver: class % is forbidden and cannot be waived', p_decision_class
      using errcode = '22023';
  end if;

  if p_expires_at <= v_now then
    raise exception 'grant_autopilot_waiver: expires_at must be in the future'
      using errcode = '22023';
  end if;
  if p_expires_at > v_max_expiry then
    raise exception 'grant_autopilot_waiver: expires_at exceeds 7-day ceiling (max %)', v_max_expiry
      using errcode = '22023';
  end if;

  if p_max_daily_usd is null or p_max_daily_usd < 0 then
    raise exception 'grant_autopilot_waiver: max_daily_usd must be >= 0'
      using errcode = '22023';
  end if;
  if p_max_daily_usd > 100 then
    raise exception 'grant_autopilot_waiver: max_daily_usd exceeds $100 ceiling'
      using errcode = '22023';
  end if;

  if p_cooling_off_seconds is null or p_cooling_off_seconds < 0 then
    raise exception 'grant_autopilot_waiver: cooling_off_seconds must be >= 0'
      using errcode = '22023';
  end if;

  insert into tenant_decision_class_overrides (
    tenant_id, decision_class, autonomy,
    waiver_expires_at, waiver_max_daily_usd, waiver_cooling_off_seconds
  ) values (
    p_tenant_id, p_decision_class, 'auto'::decision_autonomy,
    p_expires_at, p_max_daily_usd, p_cooling_off_seconds
  )
  on conflict (tenant_id, decision_class) do update
    set autonomy                   = 'auto'::decision_autonomy,
        waiver_expires_at          = excluded.waiver_expires_at,
        waiver_max_daily_usd       = excluded.waiver_max_daily_usd,
        waiver_cooling_off_seconds = excluded.waiver_cooling_off_seconds,
        updated_at                 = now();

  insert into autopilot_action_ledger (
    tenant_id, action, evidence
  ) values (
    p_tenant_id, 'dispatch',
    jsonb_build_object(
      'kind',                'waiver_grant',
      'class',               p_decision_class,
      'expires_at',          p_expires_at,
      'max_daily_usd',       p_max_daily_usd,
      'cooling_off_seconds', p_cooling_off_seconds
    )
  );

  return jsonb_build_object('ok', true);
end $$;

revoke all on function grant_autopilot_waiver(uuid, text, timestamptz, numeric, int) from public;
grant execute on function grant_autopilot_waiver(uuid, text, timestamptz, numeric, int) to service_role;

commit;
