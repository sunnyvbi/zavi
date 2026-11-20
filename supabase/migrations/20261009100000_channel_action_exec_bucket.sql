
create table if not exists ops_alert_outbox (
  id              bigint generated always as identity primary key,
  dedupe_key      text not null unique check (char_length(dedupe_key) between 1 and 200),
  source          text not null check (char_length(source) between 1 and 64),
  code            text not null check (char_length(code) between 1 and 64),
  tenant_id       uuid,
  msg             text not null check (char_length(msg) <= 1500),
  status          text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts        int  not null default 0 check (attempts >= 0),
  last_error      text check (last_error is null or char_length(last_error) <= 500),
  next_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create index if not exists ops_alert_outbox_due_idx
  on ops_alert_outbox (next_attempt_at) where status in ('pending', 'sending');
alter table ops_alert_outbox enable row level security;

comment on table ops_alert_outbox is
  'Internal alerts, one row per incident key (unique dedupe_key). Enqueued in the same transaction as the event that raised it; delivered at least once by ops-alert-outbox-drain. 20261009100000.';

create or replace function enqueue_ops_alert(
  p_dedupe_key text,
  p_source     text,
  p_code       text,
  p_tenant_id  uuid,
  p_msg        text
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id bigint;
begin
  if nullif(trim(p_dedupe_key), '') is null or nullif(trim(p_source), '') is null
     or nullif(trim(p_code), '') is null or p_msg is null then
    raise exception 'enqueue_ops_alert: dedupe_key, source, code and msg are required';
  end if;
  insert into ops_alert_outbox (dedupe_key, source, code, tenant_id, msg)
  values (left(trim(p_dedupe_key), 200), left(trim(p_source), 64), left(trim(p_code), 64), p_tenant_id, left(p_msg, 1500))
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  return v_id is not null;
end $$;

create or replace function claim_ops_alerts(p_limit int)
returns setof ops_alert_outbox
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  update ops_alert_outbox o
     set status = 'sending',
         attempts = o.attempts + 1,
         next_attempt_at = now() + interval '5 minutes'
   where o.id in (select q.id from ops_alert_outbox q
                   where q.status in ('pending', 'sending') and q.next_attempt_at <= now()
                   order by q.next_attempt_at, q.id
                   limit least(greatest(coalesce(p_limit, 50), 1), 200)
                   for update skip locked)
  returning o.*;
end $$;

create or replace function finish_ops_alert(p_id bigint, p_attempt int, p_ok boolean, p_error text)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  update ops_alert_outbox
     set status = case when p_ok then 'sent' when attempts >= 10 then 'failed' else 'pending' end,
         sent_at = case when p_ok then now() else sent_at end,
         last_error = left(p_error, 500),
         next_attempt_at = case when p_ok then next_attempt_at
                                else now() + make_interval(secs => least(3600, 30 * power(2, greatest(attempts - 1, 0)))) end
   where id = p_id and status = 'sending' and attempts = p_attempt;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

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

create or replace function exec_blocked_note(p_exec_class text)
returns text
language sql immutable set search_path = public, pg_temp as $$
  select (case split_part(coalesce(p_exec_class, ''), '.', 1)
            when 'chatgpt_ads'     then 'ChatGPT Ads'
            when 'google_ads'      then 'Google Ads'
            when 'meta_ads'        then 'Meta Ads'
            when 'generated_video' then 'AI UGC Videos'
            when 'creator'         then 'Creator hire'
            else 'These' end)
         || ' refused this change, so Zavi closed the card. We''ve been alerted; nothing for you to do.';
$$;

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
                    and v_v->>'fix' in ('reconnect', 'permission', 'billing', 'credits', 'plan')
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

create or replace function settle_channel_action_exec(
  p_tenant_id uuid,
  p_action_id uuid,
  p_ok        boolean,
  p_result    jsonb,
  p_error     text,
  p_claim_id  uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row    channel_actions%rowtype;
  v_note   text := left(nullif(trim(p_error), ''), 1000);
  v_n      int;
  v_key    text;
  v_owner  boolean;
begin
  select * into v_row from channel_actions where id = p_action_id for update;
  if not found or v_row.tenant_id is distinct from p_tenant_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  v_owner := p_claim_id is not null
             and v_row.exec_claim_id is not null
             and v_row.exec_claim_id = p_claim_id;

  if v_owner
     and v_row.exec_status = (case when p_ok then 'executed' else 'failed' end) then
    return jsonb_build_object('ok', true, 'executed', p_ok, 'replayed', true);
  end if;

  if v_row.exec_status is distinct from 'dispatching' then
    return jsonb_build_object('ok', false, 'code', 'not_dispatching',
                              'exec_status', v_row.exec_status);
  end if;

  if not v_owner then
    if p_ok then
      return jsonb_build_object('ok', false, 'code', 'not_owner');
    end if;
    if v_row.exec_claimed_at is not null
       and v_row.exec_claimed_at >= now() - interval '10 minutes' then
      return jsonb_build_object('ok', false, 'code', 'lease_held',
                                'exec_claimed_at', v_row.exec_claimed_at);
    end if;
  end if;

  select count(*) into v_n from channel_action_events
   where action_id = p_action_id and event in ('executed', 'exec_failed');
  v_key := 'exec:' || p_action_id || ':' || (v_n + 1);

  if p_ok then
    update channel_actions
       set status      = 'acted',
           status_at   = now(),
           exec_status = 'executed',
           executed_at = now(),
           exec_result = coalesce(p_result, '{}'::jsonb)
     where id = p_action_id;
    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, actor_user_id, run_id, note, event_key)
    values
      (p_tenant_id, p_action_id, 'executed',
       case when v_row.approved_by_source = 'cgo' then 'system' else 'founder' end,
       v_row.approved_by, v_row.run_id, v_note, v_key);
  else
    update channel_actions
       set exec_status = 'failed',
           exec_result = coalesce(p_result, '{}'::jsonb),
           note        = coalesce(v_note, note)
     where id = p_action_id;
    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, actor_user_id, run_id, note, event_key)
    values
      (p_tenant_id, p_action_id, 'exec_failed', 'system', null, v_row.run_id, v_note, v_key);
    perform apply_exec_failure_verdict(p_tenant_id, p_action_id, v_row.run_id, p_result);
  end if;

  return jsonb_build_object('ok', true, 'executed', p_ok);
end $$;

revoke all on function settle_channel_action_exec(uuid, uuid, boolean, jsonb, text, uuid)
  from public, anon, authenticated;
grant execute on function settle_channel_action_exec(uuid, uuid, boolean, jsonb, text, uuid)
  to service_role;

drop function if exists set_channel_action_video_media(uuid, uuid, uuid, uuid, boolean, jsonb, text, text);

create or replace function set_channel_action_video_media(
  p_action_id uuid,
  p_tenant_id uuid,
  p_run_id    uuid,
  p_claim_id  uuid,
  p_ok        boolean,
  p_media     jsonb,
  p_error     text,
  p_code      text default null,
  p_verdict   jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row   channel_actions%rowtype;
  v_note  text := left(nullif(trim(p_error), ''), 1000);
  v_code  text := case when p_code ~ '^[a-z_]{1,40}$' then p_code else null end;
  v_owner boolean;
  v_n     int;
  v_key   text;
begin
  if p_action_id is null or p_tenant_id is null or p_run_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  select * into v_row from channel_actions where id = p_action_id for update;
  if not found
     or v_row.tenant_id is distinct from p_tenant_id
     or v_row.run_id is distinct from p_run_id
     or v_row.exec_class is distinct from 'generated_video.render.v1' then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if p_ok and (jsonb_typeof(p_media) is distinct from 'object'
               or p_media->>'kind' is distinct from 'video'
               or coalesce(p_media->>'storage_path', '') not like (p_tenant_id::text || '/%')) then
    return jsonb_build_object('ok', false, 'code', 'invalid_media');
  end if;

  v_owner := p_claim_id is not null
             and v_row.exec_claim_id is not null
             and v_row.exec_claim_id = p_claim_id;

  if v_owner
     and v_row.exec_status = (case when p_ok then 'executed' else 'failed' end) then
    return jsonb_build_object('ok', true, 'executed', p_ok, 'replayed', true);
  end if;

  if v_row.exec_status is distinct from 'dispatching' then
    return jsonb_build_object('ok', false, 'code', 'not_dispatching',
                              'exec_status', v_row.exec_status);
  end if;

  if not v_owner then
    if p_ok then
      return jsonb_build_object('ok', false, 'code', 'not_owner');
    end if;
    if v_row.exec_claimed_at is not null
       and v_row.exec_claimed_at >= now() - interval '10 minutes' then
      return jsonb_build_object('ok', false, 'code', 'lease_held');
    end if;
  end if;

  select count(*) into v_n from channel_action_events
   where action_id = p_action_id and event in ('executed', 'exec_failed');
  v_key := 'exec:' || p_action_id || ':' || (v_n + 1);

  if p_ok then
    update channel_actions
       set body        = jsonb_set(coalesce(body, '{}'::jsonb), '{media}', p_media, true),
           exec_status = 'executed',
           executed_at = now(),
           exec_result = jsonb_build_object('delivered', true),
           note        = null
     where id = p_action_id;
    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, actor_user_id, run_id, note, event_key)
    values
      (p_tenant_id, p_action_id, 'executed', 'founder', v_row.approved_by, v_row.run_id, null, v_key);
  else
    update channel_actions
       set exec_status = 'failed',
           exec_result = jsonb_build_object('error', v_note)
                         || case when v_code is null then '{}'::jsonb
                                 else jsonb_build_object('code', v_code) end,
           note        = coalesce(v_note, note)
     where id = p_action_id;
    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, actor_user_id, run_id, note, event_key)
    values
      (p_tenant_id, p_action_id, 'exec_failed', 'system', null, v_row.run_id, v_note, v_key);
    perform apply_exec_failure_verdict(p_tenant_id, p_action_id, v_row.run_id, p_verdict);
  end if;

  return jsonb_build_object('ok', true, 'executed', p_ok);
end $$;

revoke all on function set_channel_action_video_media(uuid, uuid, uuid, uuid, boolean, jsonb, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function set_channel_action_video_media(uuid, uuid, uuid, uuid, boolean, jsonb, text, text, jsonb)
  to service_role;

create index if not exists channel_actions_failed_open_idx
  on channel_actions (id) where exec_status = 'failed' and status in ('pending', 'snoozed');

create or replace function list_failed_open_channel_actions(p_after uuid, p_limit int)
returns table (id uuid, tenant_id uuid, channel_slug text, exec_class text, exec_result jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.id, a.tenant_id, a.channel_slug, a.exec_class, a.exec_result
    from channel_actions a
   where a.exec_status = 'failed'
     and a.status in ('pending', 'snoozed')
     and (p_after is null or a.id > p_after)
   order by a.id
   limit least(greatest(coalesce(p_limit, 200), 1), 500);
$$;

create or replace function stamp_channel_action_exec_verdict(
  p_tenant_id uuid,
  p_action_id uuid,
  p_verdict   jsonb,
  p_force     boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row channel_actions%rowtype;
  v_out jsonb;
begin
  if p_tenant_id is null or p_action_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into v_row from channel_actions where id = p_action_id for update;
  if not found or v_row.tenant_id is distinct from p_tenant_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_row.exec_status is distinct from 'failed' then
    return jsonb_build_object('ok', false, 'code', 'not_failed');
  end if;
  if jsonb_typeof(v_row.exec_result) = 'object' and v_row.exec_result ? 'bucket' then
    if not coalesce(p_force, false)
       or (v_row.exec_result->'bucket' is not distinct from p_verdict->'bucket'
           and coalesce(v_row.exec_result->'fix', 'null'::jsonb) is not distinct from coalesce(p_verdict->'fix', 'null'::jsonb)
           and coalesce(v_row.exec_result->'platform_code', 'null'::jsonb) is not distinct from coalesce(p_verdict->'platform_code', 'null'::jsonb)) then
      return jsonb_build_object('ok', true, 'replayed', true);
    end if;
  end if;
  v_out := apply_exec_failure_verdict(p_tenant_id, p_action_id, v_row.run_id, p_verdict);
  return jsonb_build_object('ok', true, 'replayed', false,
                            'stamped', v_out->'stamped', 'closed', v_out->'closed', 'bucket', v_out->'bucket');
end $$;

revoke all on function apply_exec_failure_verdict(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function classify_exec_failure(jsonb) from public, anon, authenticated;
grant execute on function classify_exec_failure(jsonb) to service_role;
revoke all on function exec_blocked_note(text) from public, anon, authenticated;
grant execute on function exec_blocked_note(text) to service_role;
revoke all on function enqueue_ops_alert(text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function enqueue_ops_alert(text, text, text, uuid, text) to service_role;
revoke all on function claim_ops_alerts(int) from public, anon, authenticated;
grant execute on function claim_ops_alerts(int) to service_role;
revoke all on function finish_ops_alert(bigint, int, boolean, text) from public, anon, authenticated;
grant execute on function finish_ops_alert(bigint, int, boolean, text) to service_role;
revoke all on function list_failed_open_channel_actions(uuid, int) from public, anon, authenticated;
grant execute on function list_failed_open_channel_actions(uuid, int) to service_role;
revoke all on function stamp_channel_action_exec_verdict(uuid, uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function stamp_channel_action_exec_verdict(uuid, uuid, jsonb, boolean) to service_role;

do $$
declare
  r        record;
  v_out    jsonb;
  v_seen   int := 0;
  v_closed int := 0;
begin
  for r in
    select a.id, a.tenant_id, a.run_id
      from channel_actions a
     where a.exec_status = 'failed'
       and not (jsonb_typeof(a.exec_result) = 'object' and a.exec_result ? 'bucket')
     order by a.id
  loop
    v_out := apply_exec_failure_verdict(r.tenant_id, r.id, r.run_id, null);
    v_seen := v_seen + 1;
    if (v_out->>'closed')::boolean then
      v_closed := v_closed + 1;
    end if;
  end loop;
  raise notice 'channel_action_exec_bucket: stamped % failed row(s), closed % blocked card(s)', v_seen, v_closed;
end $$;
