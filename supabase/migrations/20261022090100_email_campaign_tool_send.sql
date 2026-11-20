
alter table channel_actions add column if not exists exec_progress jsonb;

comment on column channel_actions.exec_progress is
  'How far a multi-step execution got: {campaign_id, stage}. Written only by record_channel_action_exec_progress, under the claim. 20261022090100.';

create or replace function record_channel_action_exec_progress(
  p_tenant_id uuid,
  p_action_id uuid,
  p_claim_id  uuid,
  p_progress  jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row       channel_actions%rowtype;
  v_stage     text := p_progress->>'stage';
  v_campaign  text := nullif(trim(p_progress->>'campaign_id'), '');
  v_old_stage text;
  v_rank      int;
  v_old_rank  int;
begin
  if p_tenant_id is null or p_action_id is null or p_claim_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  v_rank := array_position(array['created', 'content_set', 'send_requested', 'sent'], v_stage);
  if v_rank is null or v_campaign is null or char_length(v_campaign) > 200 then
    return jsonb_build_object('ok', false, 'code', 'progress_invalid');
  end if;

  select * into v_row from channel_actions where id = p_action_id for update;
  if not found or v_row.tenant_id is distinct from p_tenant_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_row.exec_status is distinct from 'dispatching'
     or v_row.exec_claim_id is null
     or v_row.exec_claim_id is distinct from p_claim_id then
    return jsonb_build_object('ok', false, 'code', 'not_owner');
  end if;

  v_old_stage := v_row.exec_progress->>'stage';
  v_old_rank  := coalesce(array_position(array['created', 'content_set', 'send_requested', 'sent'], v_old_stage), 0);
  if v_old_rank < 3 and v_row.exec_progress->>'campaign_id' is distinct from v_campaign then
    v_old_rank := 0;
  end if;
  if v_rank < v_old_rank then
    return jsonb_build_object('ok', false, 'code', 'stage_backwards');
  end if;
  if v_old_rank >= 3 and v_row.exec_progress->>'campaign_id' is distinct from v_campaign then
    return jsonb_build_object('ok', false, 'code', 'campaign_locked');
  end if;

  update channel_actions
     set exec_progress = jsonb_build_object('campaign_id', v_campaign, 'stage', v_stage)
   where id = p_action_id;
  return jsonb_build_object('ok', true, 'stage', v_stage);
end $$;

revoke all on function record_channel_action_exec_progress(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function record_channel_action_exec_progress(uuid, uuid, uuid, jsonb) to service_role;

create or replace function reconcile_channel_action_exec(
  p_tenant_id uuid,
  p_action_id uuid,
  p_ok        boolean,
  p_result    jsonb,
  p_error     text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row     channel_actions%rowtype;
  v_note    text := left(nullif(trim(p_error), ''), 1000);
  v_unknown boolean;
  v_dead    boolean;
  v_n       int;
  v_key     text;
begin
  if p_tenant_id is null or p_action_id is null or p_ok is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into v_row from channel_actions where id = p_action_id for update;
  if not found or v_row.tenant_id is distinct from p_tenant_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_row.exec_class is distinct from 'email_campaign.create_and_send' then
    return jsonb_build_object('ok', false, 'code', 'class_not_reconcilable');
  end if;
  if nullif(v_row.exec_progress->>'campaign_id', '') is null then
    return jsonb_build_object('ok', false, 'code', 'no_progress');
  end if;
  v_unknown := coalesce(v_row.exec_status = 'failed' and v_row.exec_result->>'code' = 'exec_outcome_unknown', false);
  v_dead    := coalesce(v_row.exec_status = 'dispatching'
                        and (v_row.exec_claimed_at is null
                             or v_row.exec_claimed_at < now() - interval '10 minutes'), false);
  if not (v_unknown or v_dead) then
    return jsonb_build_object('ok', false, 'code', 'not_unknown', 'exec_status', v_row.exec_status);
  end if;

  select count(*) into v_n from channel_action_events
   where action_id = p_action_id and event in ('executed', 'exec_failed');
  v_key := 'reconcile:' || p_action_id || ':' || (v_n + 1);

  if p_ok then
    update channel_actions
       set status        = case when status in ('pending', 'snoozed') then 'acted' else status end,
           status_at     = case when status in ('pending', 'snoozed') then now() else status_at end,
           exec_status   = 'executed',
           executed_at   = now(),
           exec_claim_id = null,
           exec_result   = coalesce(p_result, '{}'::jsonb),
           note          = coalesce(v_note, note)
     where id = p_action_id;
    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, actor_user_id, run_id, note, event_key)
    values
      (p_tenant_id, p_action_id, 'executed',
       case when v_row.approved_by_source = 'cgo' then 'system' else 'founder' end,
       v_row.approved_by, v_row.run_id, v_note, v_key);
  else
    update channel_actions
       set exec_status   = 'failed',
           exec_claim_id = null,
           exec_result   = coalesce(p_result, '{}'::jsonb),
           note          = coalesce(v_note, note)
     where id = p_action_id;
    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, actor_user_id, run_id, note, event_key)
    values
      (p_tenant_id, p_action_id, 'exec_failed', 'system', null, v_row.run_id, v_note, v_key);
    perform apply_exec_failure_verdict(p_tenant_id, p_action_id, v_row.run_id, p_result);
  end if;

  return jsonb_build_object('ok', true, 'executed', p_ok);
end $$;

revoke all on function reconcile_channel_action_exec(uuid, uuid, boolean, jsonb, text)
  from public, anon, authenticated;
grant execute on function reconcile_channel_action_exec(uuid, uuid, boolean, jsonb, text) to service_role;

create or replace function approve_email_campaign_send_as_cgo(
  p_tenant_id     uuid,
  p_action_id     uuid,
  p_event_key     text,
  p_actor_user_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row      channel_actions%rowtype;
  v_tool     text;
  v_audience text;
begin
  if p_tenant_id is null or p_action_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into v_row from channel_actions where id = p_action_id;
  if not found or v_row.tenant_id is distinct from p_tenant_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_row.exec_class is distinct from 'email_campaign.create_and_send' then
    return jsonb_build_object('ok', false, 'code', 'not_email_send');
  end if;
  v_tool     := nullif(trim(v_row.exec_payload->>'tool'), '');
  v_audience := nullif(trim(v_row.exec_payload->>'audience_id'), '');
  if v_tool is null or v_audience is null then
    return jsonb_build_object('ok', false, 'code', 'audience_unknown');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cgo_email_send:' || p_tenant_id::text || ':' || v_tool || ':' || v_audience, 0));

  if exists (
    select 1 from channel_actions c
     where c.tenant_id = p_tenant_id
       and c.id <> p_action_id
       and c.exec_class = 'email_campaign.create_and_send'
       and c.approved_by_source = 'cgo'
       and c.exec_payload->>'tool' = v_tool
       and c.exec_payload->>'audience_id' = v_audience
       and (c.exec_status = 'queued'
            or (c.exec_status = 'dispatching' and c.exec_claimed_at >= now() - interval '7 days')
            or (c.exec_status = 'executed' and c.executed_at >= now() - interval '7 days')
            or (c.exec_status = 'failed'
                and c.exec_progress->>'stage' in ('send_requested', 'sent')
                and c.exec_claimed_at >= now() - interval '7 days'))
  ) then
    return jsonb_build_object('ok', false, 'code', 'cgo_email_sent_recently');
  end if;

  return approve_channel_action(p_tenant_id, p_action_id, p_event_key, p_actor_user_id, 'cgo');
end $$;

revoke all on function approve_email_campaign_send_as_cgo(uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function approve_email_campaign_send_as_cgo(uuid, uuid, text, uuid) to service_role;

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
      ('email_tool_refused',                  'temporary',     null)
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

revoke all on function classify_exec_failure(jsonb) from public, anon, authenticated;

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
            else 'These' end)
         || ' refused this change, so Zavi closed the card. We''ve been alerted; nothing for you to do.';
$$;

revoke all on function exec_blocked_note(text) from public, anon, authenticated;

insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity) values
  ('email_campaign.create_and_send',
   'Create a campaign in the founder''s connected email tool (Mailchimp or Klaviyo) and send it to one of their lists. Body: the sealed tool, connection, list, subject and content.',
   'approval', 'email_campaign.create_and_send', true, false, 'high')
on conflict (slug) do update
  set default_autonomy    = excluded.default_autonomy,
      dispatch_handler    = excluded.dispatch_handler,
      never_auto          = excluded.never_auto,
      click_allowlistable = excluded.click_allowlistable,
      severity            = excluded.severity;
