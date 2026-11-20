
begin;

set lock_timeout = '5s';

create or replace function emit_decision(
  p_tenant_id uuid,
  p_agent_run_id uuid,
  p_decision_class text,
  p_body jsonb,
  p_autonomy_override decision_autonomy default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_autonomy decision_autonomy;
  v_handler text;
  v_status text;
  v_class_exists boolean;
  v_killed boolean;
  v_agent_slug text;
  v_target text;
  v_fingerprint text;
  v_is_meta_ads boolean;
  v_single_open boolean;
  v_target_paths text[];
  v_supp_key text;
  v_supp_decision uuid;
  v_custom boolean;
  v_founder boolean;
  v_marked boolean;
  v_same boolean;
  v_new uuid;
  v_google_budget boolean;
  v_campaign text;
begin
  select exists(select 1 from decision_classes where slug = p_decision_class) into v_class_exists;
  if not v_class_exists then
    raise exception 'unknown decision_class: %', p_decision_class
      using errcode = '23514';
  end if;

  if p_agent_run_id is not null then
    select agent_slug into v_agent_slug from agent_runs where id = p_agent_run_id;
    if v_agent_slug is not null then
      select exists(
        select 1 from tenant_agent_kill_switch
         where tenant_id = p_tenant_id and agent_slug = v_agent_slug
           and override_state = 'hidden'
      ) into v_killed;
      if v_killed then
        insert into decisions (
          tenant_id, agent_run_id, decision_class, body, status,
          autonomy_at_emit, handler, dispatch_error
        ) values (
          p_tenant_id, p_agent_run_id, p_decision_class, p_body, 'rejected',
          'forbidden', null, 'kill_switch'
        ) returning id into v_id;
        return v_id;
      end if;
    end if;
  end if;

  v_autonomy := effective_autonomy(p_tenant_id, p_decision_class);

  if p_autonomy_override is not null
     and p_decision_class = 'engineer.ship-pr'
     and v_autonomy = 'auto'
     and p_autonomy_override = 'approval'
  then
    v_autonomy := 'approval';
  end if;

  if p_agent_run_id is not null and v_agent_slug is not null then
    select _is_custom_agent_run(p_tenant_id, r.agent_slug, r.id, r.cron_dedupe_key)
      into v_custom
      from agent_runs r
     where r.id = p_agent_run_id
       and r.tenant_id = p_tenant_id;
    if coalesce(v_custom, false) then
      v_autonomy := 'auto';
    end if;
  end if;

  if v_autonomy = 'auto'
     and (p_decision_class like 'meta\_ads.%' or p_decision_class like 'google\_ads.%')
     and p_body->>'founder_chat_order' = 'true'
     and p_body->>'origin' in ('user_initiated_chat', 'user_initiated_ledger')
  then
    v_autonomy := 'approval';
  end if;

  select dispatch_handler, single_open_per_target, target_key_paths
    into v_handler, v_single_open, v_target_paths
  from decision_classes where slug = p_decision_class;

  if v_autonomy = 'forbidden' then
    v_status := 'rejected';
  elsif v_autonomy = 'auto' then
    v_status := 'proposed';
  else
    v_status := 'proposed';
  end if;

  v_is_meta_ads := p_decision_class like 'meta_ads.%';

  v_marked := (p_decision_class like 'meta\_ads.%' or p_decision_class like 'google\_ads.%')
    and coalesce(p_body->>'founder_chat_order' = 'true', false)
    and coalesce(p_body->>'origin' in ('user_initiated_chat', 'user_initiated_ledger'), false);
  v_founder := v_marked and not coalesce(p_body->>'founder_order_unverified' = 'true', false);
  v_google_budget := p_decision_class in ('google_ads.update_campaign_budget', 'google_ads.update_campaign_budget_review');
  v_campaign := nullif(p_body->>'campaign_id', '');

  if v_status = 'proposed' and v_google_budget and v_campaign is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || '|google_budget|' || v_campaign, 0));
    if not v_marked and p_agent_run_id is not null then
      select d.id,
             (d.body->'daily_budget_usd' = p_body->'daily_budget_usd'
              and d.body->'expected_current_daily_budget_usd' is not distinct from p_body->'expected_current_daily_budget_usd')
        into v_id, v_same
        from decisions d
       where d.tenant_id = p_tenant_id
         and d.decision_class in ('google_ads.update_campaign_budget', 'google_ads.update_campaign_budget_review')
         and d.status = 'proposed'
         and d.superseded_at is null
         and d.body->>'campaign_id' = v_campaign
         and coalesce(d.body->>'founder_chat_order' = 'true' and d.body->>'origin' in ('user_initiated_chat', 'user_initiated_ledger'), false)
       order by d.emitted_at desc, d.id desc
       limit 1;
      if v_id is not null then
      if v_same then
          return v_id;
        end if;
        insert into decisions (
          tenant_id, agent_run_id, decision_class, body, status,
          autonomy_at_emit, handler, superseded_at, superseded_by
        ) values (
          p_tenant_id, p_agent_run_id, p_decision_class, p_body, 'superseded',
          v_autonomy, v_handler, now(), v_id
        ) returning id into v_new;
        return v_new;
      end if;
    end if;
    select d.id into v_id
      from decisions d
     where d.tenant_id = p_tenant_id
       and d.decision_class = p_decision_class
       and d.status = 'proposed'
       and d.superseded_at is null
       and d.autonomy_at_emit = v_autonomy
       and d.handler is not distinct from v_handler
       and d.body->>'campaign_id' = v_campaign
       and jsonb_typeof(p_body->'daily_budget_usd') = 'number'
       and d.body->'daily_budget_usd' = p_body->'daily_budget_usd'
       and d.body->'expected_current_daily_budget_usd' is not distinct from p_body->'expected_current_daily_budget_usd'
       and coalesce(d.body->>'founder_chat_order' = 'true' and d.body->>'origin' in ('user_initiated_chat', 'user_initiated_ledger'), false) = v_marked
     order by d.emitted_at desc, d.id desc
     limit 1;
    if v_id is not null then
      return v_id;
    end if;
    if not v_founder then
      v_supp_key := decision_suppression_key(p_body, v_target_paths);
      if v_supp_key is not null then
        update decision_suppressions s
           set hit_count = s.hit_count + 1,
               last_hit_at = now()
         where s.tenant_id = p_tenant_id
           and s.decision_class = p_decision_class
           and s.suppression_key = v_supp_key
        returning s.decision_id into v_supp_decision;
        if v_supp_decision is not null then
          return v_supp_decision;
        end if;
      end if;
    end if;
    insert into decisions (
      tenant_id, agent_run_id, decision_class, body, status,
      autonomy_at_emit, handler
    ) values (
      p_tenant_id, p_agent_run_id, p_decision_class, p_body, v_status,
      v_autonomy, v_handler
    ) returning id into v_id;
    update decisions d
       set status = 'superseded',
           superseded_at = now(),
           superseded_by = v_id
     where d.tenant_id = p_tenant_id
       and d.decision_class in ('google_ads.update_campaign_budget', 'google_ads.update_campaign_budget_review')
       and d.status = 'proposed'
       and d.superseded_at is null
       and d.id <> v_id
       and d.body->>'campaign_id' = v_campaign
       and (v_founder or not coalesce(d.body->>'founder_chat_order' = 'true' and d.body->>'origin' in ('user_initiated_chat', 'user_initiated_ledger'), false));
    return v_id;
  end if;

  if v_status = 'proposed' and v_is_meta_ads then
    v_target := (case when regexp_replace(p_decision_class, '_review$', '') ~ '(budget|set_status)$' then coalesce(nullif(p_body->>'object_id', ''), nullif(p_body->>'ad_set_id', ''), nullif(p_body->>'campaign_id', '')) else coalesce(p_body->>'object_id', p_body->>'ad_set_id', (p_body->>'campaign_id') || '|' || coalesce(p_body->>'name', '')) end);
    if v_target is not null then
      perform pg_advisory_xact_lock(hashtextextended(
        p_tenant_id::text || '|meta_target|' || regexp_replace(p_decision_class, '_review$', '') || '|' || v_target, 0));
      if not v_marked and p_agent_run_id is not null then
        select d.id,
               (regexp_replace(p_decision_class, '_review$', '') ~ '(budget|set_status)$'
                and d.body->'daily_budget_usd' is not distinct from p_body->'daily_budget_usd'
                and d.body->'expected_current_daily_budget_usd' is not distinct from p_body->'expected_current_daily_budget_usd'
                and d.body->'status' is not distinct from p_body->'status')
          into v_id, v_same
          from decisions d
         where d.tenant_id = p_tenant_id
           and regexp_replace(d.decision_class, '_review$', '') = regexp_replace(p_decision_class, '_review$', '')
           and d.status = 'proposed'
           and d.superseded_at is null
           and (case when regexp_replace(p_decision_class, '_review$', '') ~ '(budget|set_status)$' then coalesce(nullif(d.body->>'object_id', ''), nullif(d.body->>'ad_set_id', ''), nullif(d.body->>'campaign_id', '')) else coalesce(d.body->>'object_id', d.body->>'ad_set_id', (d.body->>'campaign_id') || '|' || coalesce(d.body->>'name', '')) end) = v_target
           and coalesce(d.body->>'founder_chat_order' = 'true' and d.body->>'origin' in ('user_initiated_chat', 'user_initiated_ledger'), false)
         order by d.emitted_at desc, d.id desc
         limit 1;
        if v_id is not null then
          if v_same then
            return v_id;
          end if;
          insert into decisions (
            tenant_id, agent_run_id, decision_class, body, status,
            autonomy_at_emit, handler, superseded_at, superseded_by
          ) values (
            p_tenant_id, p_agent_run_id, p_decision_class, p_body, 'superseded',
            v_autonomy, v_handler, now(), v_id
          ) returning id into v_new;
          return v_new;
        end if;
      end if;
    end if;
  end if;

  if v_status = 'proposed' and p_decision_class in ('google_ads.set_status', 'google_ads.set_status_review') and (case p_body->>'level' when 'campaign' then 'campaign:' || nullif(p_body->>'campaign_id', '') when 'ad_group' then 'ad_group:' || nullif(p_body->>'ad_group_id', '') when 'ad' then 'ad:' || nullif(p_body->>'ad_id', '') end) is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || '|google_status|' || (case p_body->>'level' when 'campaign' then 'campaign:' || nullif(p_body->>'campaign_id', '') when 'ad_group' then 'ad_group:' || nullif(p_body->>'ad_group_id', '') when 'ad' then 'ad:' || nullif(p_body->>'ad_id', '') end), 0));
    if not v_marked and p_agent_run_id is not null then
      select d.id, d.body->'status' is not distinct from p_body->'status' into v_id, v_same
        from decisions d
       where d.tenant_id = p_tenant_id
         and d.decision_class in ('google_ads.set_status', 'google_ads.set_status_review')
         and d.status = 'proposed'
         and d.superseded_at is null
         and (case d.body->>'level' when 'campaign' then 'campaign:' || nullif(d.body->>'campaign_id', '') when 'ad_group' then 'ad_group:' || nullif(d.body->>'ad_group_id', '') when 'ad' then 'ad:' || nullif(d.body->>'ad_id', '') end) = (case p_body->>'level' when 'campaign' then 'campaign:' || nullif(p_body->>'campaign_id', '') when 'ad_group' then 'ad_group:' || nullif(p_body->>'ad_group_id', '') when 'ad' then 'ad:' || nullif(p_body->>'ad_id', '') end)
         and coalesce(d.body->>'founder_chat_order' = 'true' and d.body->>'origin' in ('user_initiated_chat', 'user_initiated_ledger'), false)
       order by d.emitted_at desc, d.id desc
       limit 1;
      if v_id is not null then
        if v_same then
          return v_id;
        end if;
        insert into decisions (
          tenant_id, agent_run_id, decision_class, body, status,
          autonomy_at_emit, handler, superseded_at, superseded_by
        ) values (
          p_tenant_id, p_agent_run_id, p_decision_class, p_body, 'superseded',
          v_autonomy, v_handler, now(), v_id
        ) returning id into v_new;
        return v_new;
      end if;
    end if;
  end if;

  if v_status = 'proposed' and not v_is_meta_ads then
    v_fingerprint := decision_content_fingerprint(p_body);
    perform pg_advisory_xact_lock(
      hashtextextended(
        p_tenant_id::text || '|' || p_decision_class || '|' || v_fingerprint
          || '|' || v_autonomy::text,
        0
      )
    );
    select d.id into v_id
      from decisions d
     where d.tenant_id = p_tenant_id
       and d.decision_class = p_decision_class
       and d.status = 'proposed'
       and d.superseded_at is null
       and d.autonomy_at_emit = v_autonomy
       and d.handler is not distinct from v_handler
       and decision_content_fingerprint(d.body) = v_fingerprint
     order by d.emitted_at asc, d.id asc
     limit 1;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  if v_status = 'proposed' and not coalesce(v_founder, false) then
    v_supp_key := decision_suppression_key(p_body, v_target_paths);
    if v_supp_key is not null then
      update decision_suppressions s
         set hit_count = s.hit_count + 1,
             last_hit_at = now()
       where s.tenant_id = p_tenant_id
         and s.decision_class = p_decision_class
         and s.suppression_key = v_supp_key
      returning s.decision_id into v_supp_decision;
      if v_supp_decision is not null then
        return v_supp_decision;
      end if;
    end if;
  end if;

  insert into decisions (
    tenant_id, agent_run_id, decision_class, body, status,
    autonomy_at_emit, handler
  ) values (
    p_tenant_id, p_agent_run_id, p_decision_class, p_body, v_status,
    v_autonomy, v_handler
  ) returning id into v_id;

  if v_status = 'proposed' and v_is_meta_ads then
    v_target := coalesce(
      p_body->>'object_id',
      p_body->>'ad_set_id',
      (p_body->>'campaign_id') || '|' || coalesce(p_body->>'name', '')
    );
    if v_target is not null then
      update decisions d
         set status = 'superseded',
             superseded_at = now(),
             superseded_by = v_id
       where d.tenant_id = p_tenant_id
         and d.decision_class = p_decision_class
         and d.status = 'proposed'
         and d.id <> v_id
         and (v_founder or not coalesce(d.body->>'founder_chat_order' = 'true' and d.body->>'origin' in ('user_initiated_chat', 'user_initiated_ledger'), false))
         and coalesce(
               d.body->>'object_id',
               d.body->>'ad_set_id',
               (d.body->>'campaign_id') || '|' || coalesce(d.body->>'name', '')
             ) = v_target;
    end if;
  end if;

  if v_status = 'proposed' and v_is_meta_ads and v_founder then
    v_target := (case when regexp_replace(p_decision_class, '_review$', '') ~ '(budget|set_status)$' then coalesce(nullif(p_body->>'object_id', ''), nullif(p_body->>'ad_set_id', ''), nullif(p_body->>'campaign_id', '')) else coalesce(p_body->>'object_id', p_body->>'ad_set_id', (p_body->>'campaign_id') || '|' || coalesce(p_body->>'name', '')) end);
    if v_target is not null then
      update decisions d
         set status = 'superseded',
             superseded_at = now(),
             superseded_by = v_id
       where d.tenant_id = p_tenant_id
         and regexp_replace(d.decision_class, '_review$', '') = regexp_replace(p_decision_class, '_review$', '')
         and d.decision_class <> p_decision_class
         and d.status = 'proposed'
         and d.superseded_at is null
         and d.id <> v_id
         and (case when regexp_replace(p_decision_class, '_review$', '') ~ '(budget|set_status)$' then coalesce(nullif(d.body->>'object_id', ''), nullif(d.body->>'ad_set_id', ''), nullif(d.body->>'campaign_id', '')) else coalesce(d.body->>'object_id', d.body->>'ad_set_id', (d.body->>'campaign_id') || '|' || coalesce(d.body->>'name', '')) end) = v_target;
    end if;
  end if;

  if v_status = 'proposed' and v_founder and p_decision_class in ('google_ads.set_status', 'google_ads.set_status_review') and (case p_body->>'level' when 'campaign' then 'campaign:' || nullif(p_body->>'campaign_id', '') when 'ad_group' then 'ad_group:' || nullif(p_body->>'ad_group_id', '') when 'ad' then 'ad:' || nullif(p_body->>'ad_id', '') end) is not null then
    update decisions d
       set status = 'superseded',
           superseded_at = now(),
           superseded_by = v_id
     where d.tenant_id = p_tenant_id
       and d.decision_class in ('google_ads.set_status', 'google_ads.set_status_review')
       and d.status = 'proposed'
       and d.superseded_at is null
       and d.id <> v_id
       and (case d.body->>'level' when 'campaign' then 'campaign:' || nullif(d.body->>'campaign_id', '') when 'ad_group' then 'ad_group:' || nullif(d.body->>'ad_group_id', '') when 'ad' then 'ad:' || nullif(d.body->>'ad_id', '') end) = (case p_body->>'level' when 'campaign' then 'campaign:' || nullif(p_body->>'campaign_id', '') when 'ad_group' then 'ad_group:' || nullif(p_body->>'ad_group_id', '') when 'ad' then 'ad:' || nullif(p_body->>'ad_id', '') end);
  end if;

  if v_status = 'proposed' and not v_is_meta_ads and coalesce(v_single_open, false) then
    v_target := decision_target_key(p_body, v_target_paths);
    if v_target is not null then
      update decisions d
         set status = 'superseded',
             superseded_at = now(),
             superseded_by = v_id
       where d.tenant_id = p_tenant_id
         and d.decision_class = p_decision_class
         and d.status = 'proposed'
         and d.superseded_at is null
         and d.id <> v_id
         and (v_founder or not coalesce(d.body->>'founder_chat_order' = 'true' and d.body->>'origin' in ('user_initiated_chat', 'user_initiated_ledger'), false))
         and decision_target_key(d.body, v_target_paths) = v_target;
    end if;
  end if;

  return v_id;
end $$;
revoke all on function emit_decision(uuid, uuid, text, jsonb, decision_autonomy) from public, anon, authenticated;
grant execute on function emit_decision(uuid, uuid, text, jsonb, decision_autonomy) to service_role;

create or replace function decide_decision_as_cgo(
  p_decision_id uuid,
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_action text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_status text;
  v_rows int;
  v_final_status text;
begin
  if p_action is distinct from 'approve' then
    raise exception 'invalid action %', p_action using errcode = '22023';
  end if;

  select tenant_id, status into v_tenant, v_status
    from decisions where id = p_decision_id;
  if v_tenant is null then
    raise exception 'decision % not found', p_decision_id using errcode = '42704';
  end if;

  if v_tenant <> p_tenant_id then
    raise exception 'cross_tenant: decision % belongs to a different tenant', p_decision_id
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from tenant_users
     where user_id = p_actor_user_id and tenant_id = p_tenant_id and role = 'owner'
  ) then
    raise exception 'not_member: actor is not the owner of tenant %', p_tenant_id
      using errcode = '42501';
  end if;

  if v_status <> 'proposed' then
    return jsonb_build_object('changed', false, 'status', v_status);
  end if;

  update decisions
     set status             = 'approved',
         approved_by        = p_actor_user_id,
         approved_at        = now(),
         approved_by_source = 'cgo'
   where id = p_decision_id and status = 'proposed'
     and coalesce(body->>'origin', '') not in ('user_initiated_chat', 'user_initiated_ledger');

  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    select status into v_final_status from decisions where id = p_decision_id;
    return jsonb_build_object('changed', false, 'status', coalesce(v_final_status, v_status));
  end if;

  return jsonb_build_object('changed', true, 'status', 'approved');
end $$;
revoke all on function decide_decision_as_cgo(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function decide_decision_as_cgo(uuid, uuid, uuid, text) to service_role;

create or replace function record_channel_exec_action(
  p_tenant_id uuid,
  p_run_id    uuid,
  p_action    jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant  uuid;
  v_channel text;
  v_class   text;
  v_payload jsonb;
  v_title   text;
  v_type    text;
  v_pos     int;
  v_id      uuid;
  v_kind    text;
  v_primary text;
  v_done    text;
  v_howto   jsonb;
  v_obj     text;
  v_subject text;
  v_old     uuid;
  v_replaced int := 0;
  v_family  text;
  v_norm    jsonb;
  v_target  text;
  v_judged  uuid[];
  v_want    uuid;
  v_repeat  uuid;
  v_status  text;
  v_untouched boolean;
  v_retire  uuid[] := '{}';
  v_retired uuid[] := '{}';
  v_unseen  uuid;
  v_founder boolean;
begin
  select tenant_id, channel_slug into v_tenant, v_channel
    from agent_runs where id = p_run_id;
  if v_tenant is null then
    return jsonb_build_object('ok', false, 'code', 'no_run');
  end if;
  if p_tenant_id is distinct from v_tenant then
    raise exception 'record_channel_exec_action: run % belongs to tenant %, not %',
      p_run_id, v_tenant, p_tenant_id using errcode = 'P0001';
  end if;
  if v_channel is null then
    return jsonb_build_object('ok', false, 'code', 'unstamped_run');
  end if;

  v_class   := nullif(trim(p_action->>'exec_class'), '');
  v_title   := left(nullif(trim(p_action->>'title'), ''), 300);
  v_type    := p_action->>'action_type';
  if v_class is null or v_title is null
     or jsonb_typeof(p_action->'exec_payload') is distinct from 'object'
     or jsonb_typeof(p_action->'body') is distinct from 'object' then
    return jsonb_build_object('ok', false, 'code', 'invalid_action');
  end if;
  v_payload := p_action->'exec_payload';
  if v_type is null or v_type not in (
       'text_post','image_post','video_post','reply','send_message',
       'create_ad','update_ad','pause_ad','fix','check','setup','page','other') then
    v_type := 'other';
  end if;

  v_founder := coalesce(v_payload->>'founder_chat_order' = 'true', false)
    and coalesce(v_payload->>'origin' in ('user_initiated_chat', 'user_initiated_ledger'), false)
    and not coalesce(v_payload->>'founder_order_unverified' = 'true', false);

  perform pg_advisory_xact_lock(hashtextextended('channel_card:' || v_tenant || ':' || v_channel, 0));

  select id into v_id
    from channel_actions
   where run_id = p_run_id
     and tenant_id = v_tenant
     and exec_class = v_class
     and exec_payload = v_payload
   limit 1;
  if v_id is not null then
    return jsonb_build_object('ok', true, 'id', v_id, 'replayed', true);
  end if;

  v_family := regexp_replace(v_class, '_review$', '');
  v_norm   := v_payload - 'rationale' - 'decision_evidence' - 'about';
  v_target := left(nullif(trim(p_action->>'target_key'), ''), 300);
  if jsonb_typeof(p_action->'judged_ids') = 'array' then
    select coalesce(array_agg(e::uuid), '{}'::uuid[]) into v_judged
      from jsonb_array_elements_text(p_action->'judged_ids') as j(e)
     where e ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  end if;
  if (p_action->>'repeat_of') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_want := (p_action->>'repeat_of')::uuid;
  end if;
  v_obj := coalesce(nullif(v_payload->>'criterion_id', ''), nullif(v_payload->>'ad_id', ''),
                    nullif(v_payload->>'object_id', ''), nullif(v_payload->>'ad_set_id', ''),
                    nullif(v_payload->>'ad_group_id', ''), nullif(v_payload->>'campaign_id', ''));
  if v_type in ('update_ad', 'pause_ad') and v_obj is not null then
    v_subject := concat_ws('|', v_payload->>'level', v_payload->>'parent_id', v_obj);
  end if;

  if v_judged is not null and v_target is not null then
    select id into v_unseen
      from channel_actions
     where tenant_id = v_tenant
       and channel_slug = v_channel
       and status in ('pending', 'snoozed')
       and target_key = v_target
       and not (id = any(v_judged))
       and id is distinct from v_want
     limit 1;
    if v_unseen is not null then
      return jsonb_build_object('ok', false, 'code', 'rematch', 'reason', 'unseen_same_target');
    end if;
  end if;

  if v_want is not null then
    select id, status,
           (status in ('pending', 'snoozed')
            and (status = 'pending' or snoozed_until is null or snoozed_until <= now())
            and (exec_status is null
                 or (exec_status = 'failed'
                     and coalesce(exec_result->>'bucket', '') in ('blocked_on_us', 'needs_founder')
                     and coalesce(exec_result->>'code', '') not in ('exec_partial', 'exec_outcome_unknown')
                     and not (coalesce(exec_result, '{}'::jsonb) ? 'interrupted')
                     and not (coalesce(exec_result, '{}'::jsonb) ? 'lease_expired')))
            and coalesce(exec_result->>'bucket', '') <> 'partial_risk'
            and edited_body is null
            and (v_founder or coalesce(exec_payload->>'origin', '') not in ('user_initiated_chat', 'user_initiated_ledger'))
            and steps_done = '[]'::jsonb)
      into v_repeat, v_status, v_untouched
      from channel_actions
     where id = v_want
       and tenant_id = v_tenant
       and channel_slug = v_channel
     for update;
    if v_repeat is not null and v_status not in ('pending', 'snoozed') then
      return jsonb_build_object('ok', false, 'code', 'rematch', 'reason', 'repeat_closed');
    end if;
    if v_repeat is not null and not v_untouched then
      return jsonb_build_object('ok', true, 'id', v_repeat, 'replayed', false, 'kept', true);
    end if;
    if v_repeat is not null then
      v_retire := array[v_repeat];
    end if;
  end if;

  for v_old, v_untouched in
    select id,
           ((status = 'pending' or snoozed_until is null or snoozed_until <= now())
            and (exec_status is null
                 or (exec_status = 'failed'
                     and coalesce(exec_result->>'bucket', '') in ('blocked_on_us', 'needs_founder')
                     and coalesce(exec_result->>'code', '') not in ('exec_partial', 'exec_outcome_unknown')
                     and not (coalesce(exec_result, '{}'::jsonb) ? 'interrupted')
                     and not (coalesce(exec_result, '{}'::jsonb) ? 'lease_expired')))
            and coalesce(exec_result->>'bucket', '') <> 'partial_risk'
            and edited_body is null
            and (v_founder or coalesce(exec_payload->>'origin', '') not in ('user_initiated_chat', 'user_initiated_ledger'))
            and steps_done = '[]'::jsonb)
      from channel_actions
     where tenant_id = v_tenant
       and channel_slug = v_channel
       and status in ('pending', 'snoozed')
       and exec_class is not null
       and regexp_replace(exec_class, '_review$', '') = v_family
       and id is distinct from v_repeat
       and ((v_subject is not null
             and action_type in ('update_ad', 'pause_ad')
             and concat_ws('|', exec_payload->>'level', exec_payload->>'parent_id',
                   coalesce(nullif(exec_payload->>'criterion_id', ''), nullif(exec_payload->>'ad_id', ''),
                            nullif(exec_payload->>'object_id', ''), nullif(exec_payload->>'ad_set_id', ''),
                            nullif(exec_payload->>'ad_group_id', ''), nullif(exec_payload->>'campaign_id', '')))
                 = v_subject)
            or ((v_norm - 'name' - 'campaign_name') <> '{}'::jsonb
                and (exec_payload - 'rationale' - 'decision_evidence' - 'about') = v_norm))
     order by proposed_at desc, id desc
     for update
  loop
    if not v_untouched then
      return jsonb_build_object('ok', true, 'id', v_old, 'replayed', false, 'kept', true);
    end if;
    v_retire := v_retire || v_old;
  end loop;

  if cardinality(v_retire) > 0 then
    with retired as (
      update channel_actions
         set status = 'stale', status_at = now(),
             note = left('Replaced by a newer version: ' || v_title, 1000)
       where tenant_id = v_tenant
         and channel_slug = v_channel
         and id = any(v_retire)
         and status in ('pending', 'snoozed')
         and (status = 'pending' or snoozed_until is null or snoozed_until <= now())
         and (exec_status is null
              or (exec_status = 'failed'
                  and coalesce(exec_result->>'bucket', '') in ('blocked_on_us', 'needs_founder')
                  and coalesce(exec_result->>'code', '') not in ('exec_partial', 'exec_outcome_unknown')
                  and not (coalesce(exec_result, '{}'::jsonb) ? 'interrupted')
                  and not (coalesce(exec_result, '{}'::jsonb) ? 'lease_expired')))
         and coalesce(exec_result->>'bucket', '') <> 'partial_risk'
         and edited_body is null
         and (v_founder or coalesce(exec_payload->>'origin', '') not in ('user_initiated_chat', 'user_initiated_ledger'))
         and steps_done = '[]'::jsonb
      returning id, proposed_at
    )
    select coalesce(array_agg(id order by proposed_at desc, id desc), '{}'::uuid[]) into v_retired from retired;
    v_repeat := case when v_repeat = any(v_retired) then v_repeat else v_retired[1] end;
  end if;

  select greatest(coalesce(max(position), 899) + 1, 900) into v_pos
    from channel_actions where run_id = p_run_id and position >= 900;

  v_kind    := nullif(trim(p_action->>'card_kind'), '');
  v_primary := left(nullif(trim(p_action->>'primary_label'), ''), 60);
  v_done    := left(nullif(trim(p_action->>'done_label'), ''), 60);
  v_howto   := p_action->'how_to';
  if v_kind is null or v_kind not in ('executes','post','plan','message','ad_manual','copy_to_site','task')
     or v_primary is null or v_done is null then
    v_kind := null; v_primary := null; v_done := null;
  end if;
  if jsonb_typeof(v_howto) is distinct from 'array' or jsonb_array_length(v_howto) > 12 then
    v_howto := '[]'::jsonb;
  end if;

  insert into channel_actions
    (tenant_id, channel_slug, run_id, position, run_of, blocking, action_type,
     title, title_key, body, exec_class, exec_payload, score, score_inputs, scored_at,
     card_kind, primary_label, done_label, how_to, repeat_of, target_key)
  values
    (v_tenant, v_channel, p_run_id, v_pos, v_pos,
     coalesce((p_action->>'blocking')::boolean, false), v_type,
     v_title,
     coalesce(nullif(p_action->>'title_key', ''),
              lower(regexp_replace(v_title, '\s+', ' ', 'g'))),
     p_action->'body', v_class, v_payload,
     case when jsonb_typeof(p_action->'score') = 'number'
          then greatest(0, least(100, (p_action->>'score')::numeric)) else 0 end,
     case when jsonb_typeof(p_action->'score_inputs') = 'object'
          then p_action->'score_inputs' else '{}'::jsonb end,
     now(),
     v_kind, v_primary, v_done, v_howto, v_repeat, v_target)
  returning id into v_id;

  foreach v_old in array v_retired
  loop
    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, run_id, note, event_key)
    values
      (v_tenant, v_old, 'stale_flagged', 'channel_run', p_run_id,
       left('Replaced by a newer version: ' || v_title, 1000), 'replaced:' || v_id)
    on conflict (action_id, event_key) do nothing;
    v_replaced := v_replaced + 1;
  end loop;

  insert into channel_action_events
    (tenant_id, action_id, event, actor_kind, run_id, event_key)
  values
    (v_tenant, v_id, 'proposed', 'channel_run', p_run_id, 'proposed:' || v_id)
  on conflict (action_id, event_key) do nothing;

  return jsonb_build_object('ok', true, 'id', v_id, 'replayed', false, 'position', v_pos,
                            'replaced', v_replaced, 'repeat_of', v_repeat);
end $$;
revoke all on function record_channel_exec_action(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function record_channel_exec_action(uuid, uuid, jsonb) to service_role;

commit;
