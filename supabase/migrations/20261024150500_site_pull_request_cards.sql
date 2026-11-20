
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
      ('google_ads_mutate_incomplete',        'partial_risk',  null),
      ('email_tool_not_connected',            'needs_founder', 'reconnect'),
      ('email_audience_missing',              'temporary',     null),
      ('email_tool_refused',                  'temporary',     null),
      ('github_not_connected',                'needs_founder', 'reconnect')
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

  if v_text ~ 'cap_refuse: ad_budget_(over_month|over_daily_limit)\y' then
    v_bucket := 'needs_founder'; v_fix := 'ad_budget';
  elsif v_text ~ '"status":\s*"UNAUTHENTICATED"|authenticationError|invalid_grant' then
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

create or replace function exec_blocked_note(p_exec_class text)
returns text
language sql immutable set search_path = public, pg_temp as $$
  select (case split_part(coalesce(p_exec_class, ''), '.', 1)
            when 'chatgpt_ads'     then 'ChatGPT Ads'
            when 'google_ads'      then 'Google Ads'
            when 'linkedin_ads'    then 'LinkedIn Ads'
            when 'meta_ads'        then 'Meta Ads'
            when 'generated_video' then 'AI UGC Videos'
            when 'creator'         then 'Creator hire'
            when 'email_campaign'  then 'Mailchimp or Klaviyo'
            when 'seo'             then 'GitHub'
            when 'geo'             then 'GitHub'
            else 'These' end)
         || ' refused this change, so Zavi closed the card. We''ve been alerted; nothing for you to do.';
$$;

revoke all on function classify_exec_failure(jsonb) from public, anon, authenticated;
revoke all on function exec_blocked_note(text) from public, anon, authenticated;

create or replace function set_site_pr_waiting(
  p_tenant_id uuid,
  p_action_id uuid,
  p_claim_id  uuid,
  p_waiting   boolean
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row channel_actions%rowtype;
begin
  if p_tenant_id is null or p_action_id is null or p_claim_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into v_row from channel_actions where id = p_action_id for update;
  if not found or v_row.tenant_id is distinct from p_tenant_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_row.exec_class is null or v_row.exec_class not in ('seo.create_pr.v1', 'geo.create_pr.v1') then
    return jsonb_build_object('ok', false, 'code', 'wrong_class');
  end if;
  if v_row.exec_status is distinct from 'dispatching'
     or v_row.exec_claim_id is null
     or v_row.exec_claim_id is distinct from p_claim_id then
    return jsonb_build_object('ok', false, 'code', 'not_owner');
  end if;
  update channel_actions
     set exec_result = case when p_waiting
                            then jsonb_build_object('site_pr_waiting', 'approvals')
                            else '{}'::jsonb end
   where id = p_action_id;
  return jsonb_build_object('ok', true, 'waiting', p_waiting);
end $$;
revoke all on function set_site_pr_waiting(uuid, uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function set_site_pr_waiting(uuid, uuid, uuid, boolean) to service_role;
