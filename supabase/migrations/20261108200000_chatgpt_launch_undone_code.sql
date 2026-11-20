
begin;

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
      ('meta_ads_custom_audience_terms',      'needs_founder', 'audience_terms'),
      ('meta_ads_bid_unavailable',            'blocked_on_us', null),
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
      ('email_content_changed',               'temporary',     null),
      ('email_content_unverifiable',          'temporary',     null),
      ('github_not_connected',                'needs_founder', 'reconnect'),
      ('reddit_ads_invalid_request',          'needs_founder', null),
      ('reddit_ads_retained_object_archived', 'needs_founder', null),
      ('chatgpt_ads_launch_undone',           'blocked_on_us', null)
    ) as c(code, bucket, fix)
   where c.code = v_code;
  if v_bucket is not null then
    return jsonb_build_object('bucket', v_bucket, 'fix', v_fix,
                              'platform_code', case when v_bucket = 'blocked_on_us' then v_code end);
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
      elsif v_num = 2663 then
        return jsonb_build_object('bucket', 'needs_founder', 'fix', 'audience_terms', 'platform_code', v_meta);
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

revoke all on function classify_exec_failure(jsonb) from public, anon, authenticated;

create or replace function supersede_channel_actions_by_direct_ask(
  p_tenant_id uuid,
  p_new_id    uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_new     channel_actions%rowtype;
  v_classes text[] := array['chatgpt_ads.create_and_launch', 'tiktok_ads.create_launch', 'meta_ads.launch_campaign',
                            'google_ads.create_campaign', 'x_ads.create_campaign', 'linkedin_ads.launch_campaign'];
  v_closed  jsonb := '[]'::jsonb;
  v_note    text;
  v_ids     uuid[] := '{}';
  v_id      uuid;
begin
  if p_tenant_id is null or p_new_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid');
  end if;
  select * into v_new from channel_actions where id = p_new_id and tenant_id = p_tenant_id;
  if v_new.id is null or v_new.exec_class is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('channel_card:' || p_tenant_id || ':' || v_new.channel_slug, 0));

  v_note := left('Replaced by your direct ask: ' || v_new.title, 1000);

  perform 1
     from channel_actions
    where tenant_id = p_tenant_id
      and channel_slug = v_new.channel_slug
      and id <> p_new_id
      and regexp_replace(coalesce(exec_class, ''), '_review$', '') = any(v_classes)
      and (status in ('pending', 'snoozed') or exec_status in ('queued', 'dispatching'))
    order by id
    for update;

  select id into v_id
    from channel_actions
   where tenant_id = p_tenant_id
     and channel_slug = v_new.channel_slug
     and id <> p_new_id
     and regexp_replace(coalesce(exec_class, ''), '_review$', '') = any(v_classes)
     and (exec_status in ('queued', 'dispatching')
          or (exec_status = 'executed' and status in ('pending', 'snoozed')))
   limit 1;
  if v_id is not null then
    return jsonb_build_object('ok', false, 'code', 'duplicate_in_flight', 'holder', v_id);
  end if;

  select id into v_id
    from channel_actions
   where tenant_id = p_tenant_id
     and channel_slug = v_new.channel_slug
     and id <> p_new_id
     and regexp_replace(coalesce(exec_class, ''), '_review$', '') = any(v_classes)
     and status in ('pending', 'snoozed')
     and exec_status = 'failed'
     and (coalesce(exec_result->>'code', '') in ('exec_partial', 'exec_outcome_unknown')
          or coalesce(exec_result->>'bucket', '') = 'partial_risk'
          or coalesce(exec_result, '{}'::jsonb) ? 'interrupted'
          or coalesce(exec_result, '{}'::jsonb) ? 'lease_expired')
   order by proposed_at desc, id
   limit 1;
  if v_id is not null then
    return jsonb_build_object('ok', false, 'code', 'uncertain_open', 'holder', v_id);
  end if;

  with retired as (
    update channel_actions
       set status = 'stale', status_at = now(), note = v_note
     where tenant_id = p_tenant_id
       and channel_slug = v_new.channel_slug
       and id <> p_new_id
       and regexp_replace(coalesce(exec_class, ''), '_review$', '') = any(v_classes)
       and status in ('pending', 'snoozed')
       and (exec_status is null
            or (exec_status = 'failed'
                and coalesce(exec_result->>'code', '') not in ('exec_partial', 'exec_outcome_unknown')
                and coalesce(exec_result->>'bucket', '') <> 'partial_risk'
                and not (coalesce(exec_result, '{}'::jsonb) ? 'interrupted')
                and not (coalesce(exec_result, '{}'::jsonb) ? 'lease_expired')))
    returning id, title
  )
  select coalesce(array_agg(id), '{}'::uuid[]),
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title)), '[]'::jsonb)
    into v_ids, v_closed
    from retired;

  foreach v_id in array v_ids
  loop
    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, run_id, note, event_key)
    values
      (p_tenant_id, v_id, 'stale_flagged', 'system', v_new.run_id, v_note, 'direct_ask:' || p_new_id)
    on conflict (action_id, event_key) do nothing;
  end loop;

  return jsonb_build_object('ok', true, 'superseded', to_jsonb(v_ids), 'closed', v_closed);
end $$;

revoke all on function supersede_channel_actions_by_direct_ask(uuid, uuid) from public, anon, authenticated;

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
  v_prefix text;
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
                    and v_v->>'fix' in ('reconnect', 'permission', 'billing', 'credits', 'plan', 'page_grant', 'page', 'ad_budget', 'audience_terms')
                   then v_v->>'fix' end;
  v_pcode  := case when jsonb_typeof(v_v->'platform_code') = 'string'
                   then left(nullif(v_v->>'platform_code', ''), 120) end;
  v_close  := v_bucket = 'blocked_on_us' and v_row.status in ('pending', 'snoozed');
  v_note   := case when v_close then
                case when v_row.exec_result->>'code' = 'chatgpt_ads_launch_undone'
                     then 'Zavi archived this campaign after it could not launch, so it is not running. Ask again to start a new one.'
                     else exec_blocked_note(v_row.exec_class) end
              end;

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
    if v_pcode is null then
      perform enqueue_ops_alert(
        'blocked:' || p_action_id,
        'channel_actions.exec',
        'exec_blocked_on_us',
        p_tenant_id,
        'blocked_on_us action=' || p_action_id
          || ' channel=' || coalesce(v_row.channel_slug, 'none')
          || ' class=' || coalesce(v_row.exec_class, 'none')
          || ' platform_code=none');
    end if;
  end if;

  if v_bucket = 'blocked_on_us' and v_pcode is not null then
    v_prefix := 'blocked_code:' || p_tenant_id || ':' || left(v_pcode, 100) || ':';
    perform pg_advisory_xact_lock(hashtext(v_prefix));
    if not exists (select 1 from ops_alert_outbox o
                    where left(o.dedupe_key, length(v_prefix)) = v_prefix
                      and o.created_at > now() - interval '24 hours') then
      perform enqueue_ops_alert(
        v_prefix || p_action_id,
        'channel_actions.exec',
        'exec_blocked_on_us',
        p_tenant_id,
        'blocked_on_us action=' || p_action_id
          || ' channel=' || coalesce(v_row.channel_slug, 'none')
          || ' class=' || coalesce(v_row.exec_class, 'none')
          || ' platform_code=' || v_pcode
          || '; later refusals with this code for this tenant in the next 24h are not alerted again');
    end if;
  end if;

  return jsonb_build_object('stamped', true, 'closed', v_close, 'bucket', v_bucket);
end $$;
revoke all on function apply_exec_failure_verdict(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;

do $$
declare
  r record;
  v_note text := 'Zavi archived this campaign after it could not launch, so it is not running. Ask again to start a new one.';
begin
  for r in
    select id, tenant_id, channel_slug, run_id, status in ('pending', 'snoozed') as closing
      from channel_actions
     where exec_class = 'chatgpt_ads.create_and_launch'
       and exec_status = 'failed'
       and exec_result->>'code' = 'exec_partial'
       and exec_result->>'error' like 'Zavi created ChatGPT campaign % but could not launch it, so it was archived%'
       and edited_body is null
       and steps_done = '[]'::jsonb
     order by tenant_id, channel_slug, id
  loop
    perform pg_advisory_xact_lock(hashtextextended('channel_card:' || r.tenant_id || ':' || r.channel_slug, 0));
    update channel_actions
       set exec_result = exec_result
             || jsonb_build_object('code', 'chatgpt_ads_launch_undone', 'bucket', 'blocked_on_us',
                                   'fix', null, 'platform_code', 'chatgpt_ads_launch_undone'),
           status      = case when r.closing then 'stale' else status end,
           status_at   = case when r.closing then now() else status_at end,
           note        = case when r.closing then v_note else note end
     where id = r.id
       and exec_status = 'failed'
       and exec_result->>'code' = 'exec_partial'
       and edited_body is null
       and steps_done = '[]'::jsonb
       and (not r.closing or status in ('pending', 'snoozed'));
    if found and r.closing then
      insert into channel_action_events (tenant_id, action_id, event, actor_kind, run_id, note, event_key)
      values (r.tenant_id, r.id, 'stale_flagged', 'system', r.run_id, v_note, 'blocked:' || r.id)
      on conflict (action_id, event_key) do nothing;
    end if;
  end loop;
end $$;

commit;
