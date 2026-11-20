
create or replace function classify_exec_failure(p_result jsonb)
returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  r        jsonb := case when jsonb_typeof(p_result) = 'object' then p_result else '{}'::jsonb end;
  v_code   text  := case when jsonb_typeof(r->'code') = 'string' then r->>'code' end;
  v_text   text  := case when jsonb_typeof(r->'error') = 'string' then r->>'error' else '' end;
  v_bucket text;
  v_fix    text;
  v_m      text[];
  v_num    numeric;
  v_meta   text;
  v_gcode  text;
  v_http   int;
begin
  if r->'held_for_founder' = 'true'::jsonb then
    return null;
  end if;
  if v_code in ('exec_partial', 'exec_outcome_unknown') then
    return jsonb_build_object('bucket', 'partial_risk', 'fix', null, 'platform_code', null);
  end if;

  select c.bucket, c.fix into v_bucket, v_fix
    from (values
      ('insufficient_credits',                'needs_founder', 'credits'),
      ('plan_upgrade_required',               'needs_founder', 'plan'),
      ('meta_ads_not_connected',              'needs_founder', 'reconnect'),
      ('meta_ads_token_expired',              'needs_founder', 'reconnect'),
      ('meta_ads_permission_revoked',         'needs_founder', 'permission'),
      ('meta_ads_connector_missing',          'needs_founder', 'reconnect'),
      ('meta_ads_account_not_writable',       'needs_founder', 'permission'),
      ('meta_ads_page_permission_missing',    'needs_founder', 'page_grant'),
      ('meta_ads_no_page',                    'needs_founder', 'page'),
      ('meta_ads_page_required',              'needs_founder', 'page'),
      ('google_ads_not_connected',            'needs_founder', 'reconnect'),
      ('google_ads_oauth_refresh_failed',     'needs_founder', 'reconnect'),
      ('google_ads_token_revoked',            'needs_founder', 'reconnect'),
      ('google_ads_unauthenticated',          'needs_founder', 'reconnect'),
      ('google_ads_timeout',                  'temporary',     null),
      ('google_ads_not_configured',           'blocked_on_us', null),
      ('google_ads_video_create_unsupported', 'blocked_on_us', null),
      ('google_ads_video_mutate_unsupported', 'blocked_on_us', null),
      ('google_ads_demand_gen_logo_mismatch', 'blocked_on_us', null),
      ('google_ads_non_usd_account',          'blocked_on_us', null),
      ('google_ads_mutate_partial_failure',   'partial_risk',  null),
      ('google_ads_mutate_incomplete',        'partial_risk',  null)
    ) as c(code, bucket, fix)
   where c.code = v_code;
  if v_bucket is not null then
    return jsonb_build_object('bucket', v_bucket, 'fix', v_fix, 'platform_code', null);
  end if;

  if r->'interrupted' = 'true'::jsonb or r->'lease_expired' = 'true'::jsonb or r->'kill_switch' = 'true'::jsonb then
    return jsonb_build_object('bucket', 'temporary', 'fix', null, 'platform_code', null);
  end if;
  if r->'no_handler' = 'true'::jsonb then
    return jsonb_build_object('bucket', 'blocked_on_us', 'fix', null, 'platform_code', null);
  end if;

  if v_text ~ 'Meta Ads' then
    v_m := regexp_match(v_text, '"code":\s*(\d+)(?:[^}]*"error_subcode":\s*(\d+))?');
    if v_m is not null then
      v_meta := 'meta_' || v_m[1] || coalesce('_' || v_m[2], '');
      v_num := v_m[1]::numeric;
      if v_num in (190, 102) then
        return jsonb_build_object('bucket', 'needs_founder', 'fix', 'reconnect', 'platform_code', v_meta);
      elsif v_num = 10 or v_num between 200 and 299 then
        return jsonb_build_object('bucket', 'needs_founder', 'fix', 'permission', 'platform_code', v_meta);
      elsif v_num in (1, 2, 4, 17, 32, 341, 613) or v_num between 80000 and 80014 then
        return jsonb_build_object('bucket', 'temporary', 'fix', null, 'platform_code', v_meta);
      elsif v_num = 100 then
        return jsonb_build_object('bucket', 'blocked_on_us', 'fix', null, 'platform_code', v_meta);
      end if;
    end if;
  end if;

  select left(string_agg(g.c, ',' order by g.o), 120) into v_gcode
    from (select t.m[1] as c, min(t.o) as o
            from regexp_matches(v_text, '"errorCode":\s*\{\s*"\w+":\s*"(\w+)"', 'g') with ordinality as t(m, o)
           group by t.m[1]) g;
  if v_gcode is null then
    v_gcode := (regexp_match(v_text, '"status":\s*"([A-Z_]+)"'))[1];
  end if;

  if v_text ~ '"status":\s*"UNAUTHENTICATED"|authenticationError|invalid_grant' then
    v_bucket := 'needs_founder'; v_fix := 'reconnect';
  elsif v_text ~ '"status":\s*"PERMISSION_DENIED"|authorizationError|USER_PERMISSION_DENIED|CUSTOMER_NOT_ENABLED' then
    v_bucket := 'needs_founder'; v_fix := 'permission';
  elsif v_text ~* 'billingSetupError|accountBudgetError|payment method' then
    v_bucket := 'needs_founder'; v_fix := 'billing';
  elsif v_text ~* '"status":\s*"(RESOURCE_EXHAUSTED|UNAVAILABLE|INTERNAL|DEADLINE_EXCEEDED)"|quotaError|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|timed out' then
    v_bucket := 'temporary';
  elsif v_text ~ '"status":\s*"INVALID_ARGUMENT"|MUTATE_NOT_ALLOWED|fieldError|requestError|mutateError|OPERATION_NOT_PERMITTED|NOT_SUPPORTED|body invalid|No handler is registered' then
    v_bucket := 'blocked_on_us';
  end if;
  if v_bucket is not null then
    return jsonb_build_object('bucket', v_bucket, 'fix', v_fix, 'platform_code', coalesce(v_gcode, v_meta));
  end if;

  v_http := (regexp_match(v_text, 'failed:\s*(\d{3})\y'))[1]::int;
  if v_http = 401 then
    return jsonb_build_object('bucket', 'needs_founder', 'fix', 'reconnect', 'platform_code', v_gcode);
  elsif v_http = 403 then
    return jsonb_build_object('bucket', 'needs_founder', 'fix', 'permission', 'platform_code', v_gcode);
  elsif v_http = 429 or v_http >= 500 then
    return jsonb_build_object('bucket', 'temporary', 'fix', null, 'platform_code', v_gcode);
  elsif v_http = 400 then
    return jsonb_build_object('bucket', 'blocked_on_us', 'fix', null, 'platform_code', coalesce(v_gcode, v_meta));
  end if;
  return jsonb_build_object('bucket', 'temporary', 'fix', null, 'platform_code', coalesce(v_gcode, v_meta));
end $$;

create or replace function apply_exec_failure_verdict(
  p_tenant_id uuid,
  p_action_id uuid,
  p_run_id    uuid,
  p_verdict   jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row    channel_actions%rowtype;
  v_v      jsonb := case when jsonb_typeof(p_verdict) = 'object' then p_verdict else '{}'::jsonb end;
  v_bucket text;
  v_fix    text;
  v_pcode  text;
  v_note   text;
  v_close  boolean;
begin
  select * into v_row from channel_actions
   where id = p_action_id and tenant_id = p_tenant_id
   for update;
  if not found or v_row.exec_status is distinct from 'failed' then
    return jsonb_build_object('stamped', false, 'closed', false, 'bucket', null);
  end if;

  if coalesce(v_v->>'bucket', '') not in ('blocked_on_us', 'needs_founder', 'temporary', 'partial_risk') then
    v_v := classify_exec_failure(v_row.exec_result);
    if v_v is null then
      return jsonb_build_object('stamped', false, 'closed', false, 'bucket', null);
    end if;
  end if;

  v_bucket := v_v->>'bucket';
  v_fix    := case when jsonb_typeof(v_v->'fix') = 'string'
                    and v_v->>'fix' in ('reconnect', 'permission', 'billing', 'credits', 'plan', 'page_grant', 'page')
                   then v_v->>'fix' end;
  v_pcode  := case when jsonb_typeof(v_v->'platform_code') = 'string'
                   then left(nullif(v_v->>'platform_code', ''), 120) end;
  v_close  := v_bucket = 'blocked_on_us' and v_row.status in ('pending', 'snoozed');
  v_note   := case when v_close then exec_blocked_note(v_row.exec_class) end;

  update channel_actions
     set exec_result = (case when jsonb_typeof(exec_result) = 'object' then exec_result
                             when exec_result is null then '{}'::jsonb
                             else jsonb_build_object('legacy', exec_result) end)
                       || jsonb_build_object('bucket', v_bucket, 'fix', v_fix, 'platform_code', v_pcode),
         status      = case when v_close then 'stale' else status end,
         status_at   = case when v_close then now() else status_at end,
         note        = case when v_close then v_note else note end
   where id = p_action_id;

  if v_close then
    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, run_id, note, event_key)
    values
      (p_tenant_id, p_action_id, 'stale_flagged', 'system', coalesce(p_run_id, v_row.run_id), v_note,
       'blocked:' || p_action_id)
    on conflict (action_id, event_key) do nothing;
    perform enqueue_ops_alert(
      'blocked:' || p_action_id,
      'channel_actions.exec',
      'exec_blocked_on_us',
      p_tenant_id,
      'blocked_on_us action=' || p_action_id
        || ' channel=' || coalesce(v_row.channel_slug, 'none')
        || ' class=' || coalesce(v_row.exec_class, 'none')
        || ' platform_code=' || coalesce(v_pcode, 'none'));
  end if;

  return jsonb_build_object('stamped', true, 'closed', v_close, 'bucket', v_bucket);
end $$;

revoke all on function apply_exec_failure_verdict(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function classify_exec_failure(jsonb) from public, anon, authenticated;

do $$
declare
  r     record;
  v_n   int := 0;
begin
  for r in
    select a.id, a.tenant_id, a.run_id
      from channel_actions a
     where a.exec_status = 'failed'
       and jsonb_typeof(a.exec_result) = 'object'
       and a.exec_result->>'code' in ('meta_ads_connector_missing', 'meta_ads_account_not_writable',
                                      'meta_ads_page_permission_missing', 'meta_ads_no_page', 'meta_ads_page_required')
     order by a.id
  loop
    perform apply_exec_failure_verdict(r.tenant_id, r.id, r.run_id, null);
    v_n := v_n + 1;
  end loop;
  raise notice 'meta_ad_readiness_exec_fixes: re-stamped % failed row(s)', v_n;
end $$;
