begin;

create or replace function budget_change_key(p_class text, p_payload jsonb)
returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v_family   text := regexp_replace(coalesce(p_class, ''), '_review$', '');
  v_p        jsonb := case when jsonb_typeof(p_payload) = 'object' then p_payload else '{}'::jsonb end;
  v_subject  jsonb;
  v_amount   text;
  v_expected text;
  v_num      text := '^-?[0-9]+(\.[0-9]+)?$';
begin
  if v_family in ('meta_ads.update_campaign_budget', 'google_ads.update_campaign_budget', 'chatgpt_ads.update_campaign_budget') then
    v_subject := jsonb_build_object('campaign_id', v_p->>'campaign_id');
  elsif v_family = 'meta_ads.update_ad_set_budget' then
    v_subject := jsonb_build_object('ad_set_id', v_p->>'ad_set_id');
  elsif v_family = 'tiktok_ads.update_budget' then
    v_subject := jsonb_build_object('advertiser_id', v_p->>'advertiser_id', 'level', v_p->>'level', 'object_id', v_p->>'object_id');
  elsif v_family = 'reddit_ads.update_budget' then
    v_subject := jsonb_build_object('ad_account_id', v_p->>'ad_account_id', 'ad_group_id', v_p->>'ad_group_id');
  elsif v_family = 'x_ads.update_campaign' and jsonb_typeof(v_p->'changes') = 'object' and (v_p->'changes') ? 'daily_budget' then
    v_subject := jsonb_build_object('account_id', v_p->>'account_id', 'campaign_id', v_p->>'campaign_id');
    v_amount := v_p->'changes'->>'daily_budget';
    v_expected := v_p->'before'->>'daily_budget';
  else
    return null;
  end if;
  if v_family <> 'x_ads.update_campaign' then
    v_amount := v_p->>'daily_budget_usd';
    v_expected := v_p->>'expected_current_daily_budget_usd';
  end if;
  if exists (select 1 from jsonb_each_text(v_subject) e where e.value is null or btrim(e.value) = '') then
    return null;
  end if;
  if v_amount is null or btrim(v_amount) !~ v_num then
    return null;
  end if;
  return jsonb_build_object(
    'family', v_family,
    'subject', v_subject,
    'amount', btrim(v_amount)::numeric,
    'expected', case when v_expected is not null and btrim(v_expected) ~ v_num then btrim(v_expected)::numeric end
  );
end $$;

revoke all on function budget_change_key(text, jsonb) from public, anon, authenticated;

create or replace function retire_stale_budget_proposals(
  p_tenant_id   uuid,
  p_source_kind text,
  p_source_id   uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_class    text;
  v_payload  jsonb;
  v_channel  text;
  v_run      uuid;
  v_done     boolean;
  v_at       timestamptz;
  v_key      jsonb;
  v_amount   numeric;
  v_note     text;
  v_tol      numeric;
  v_stale    uuid[] := '{}';
  v_super    uuid[] := '{}';
  v_id       uuid;
begin
  if p_tenant_id is null or p_source_id is null or p_source_kind not in ('channel_action', 'decision') then
    return jsonb_build_object('ok', false, 'code', 'invalid');
  end if;

  if p_source_kind = 'channel_action' then
    select exec_class, exec_payload, channel_slug, run_id, (status = 'acted' and exec_status = 'executed'), executed_at
      into v_class, v_payload, v_channel, v_run, v_done, v_at
      from channel_actions
     where id = p_source_id and tenant_id = p_tenant_id;
  else
    select decision_class, body, split_part(decision_class, '.', 1), agent_run_id, (status = 'acted'), coalesce(dispatched_at, approved_at)
      into v_class, v_payload, v_channel, v_run, v_done, v_at
      from decisions
     where id = p_source_id and tenant_id = p_tenant_id;
  end if;
  if v_class is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not coalesce(v_done, false) or v_at is null then
    return jsonb_build_object('ok', false, 'code', 'not_executed');
  end if;
  v_key := budget_change_key(v_class, v_payload);
  if v_key is null then
    return jsonb_build_object('ok', true, 'skipped', 'not_a_budget_change', 'stale', '[]'::jsonb, 'superseded', '[]'::jsonb);
  end if;
  v_amount := (v_key->>'amount')::numeric;
  v_tol := case when v_key->>'family' = 'x_ads.update_campaign' then 0.0000005 else 0.005 end;

  perform pg_advisory_xact_lock(hashtextextended('channel_card:' || p_tenant_id || ':' || v_channel, 0));

  v_note := 'Closed: the budget changed before this was approved, so it was based on an old amount. Zavi proposes again from the new budget.';

  with retired as (
    update channel_actions c
       set status = 'stale', status_at = now(), note = v_note
     where c.tenant_id = p_tenant_id
       and c.id is distinct from (case when p_source_kind = 'channel_action' then p_source_id end)
       and c.proposed_at < v_at
       and c.status = 'pending'
       and c.exec_status is null
       and c.approved_by is null
       and c.edited_body is null
       and coalesce(c.steps_done, '[]'::jsonb) = '[]'::jsonb
       and c.exec_class is not null
       and regexp_replace(c.exec_class, '_review$', '') = v_key->>'family'
       and budget_change_key(c.exec_class, c.exec_payload)->'subject' = v_key->'subject'
       and (budget_change_key(c.exec_class, c.exec_payload)->>'expected') is not null
       and abs((budget_change_key(c.exec_class, c.exec_payload)->>'expected')::numeric - v_amount) > v_tol
    returning c.id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_stale from retired;

  foreach v_id in array v_stale
  loop
    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, run_id, note, event_key)
    values
      (p_tenant_id, v_id, 'stale_flagged', 'system', v_run, v_note, 'budget_moved:' || p_source_kind || ':' || p_source_id)
    on conflict (action_id, event_key) do nothing;
  end loop;

  with superseded as (
    update decisions d
       set status = 'superseded',
           superseded_at = now(),
           superseded_by = case when p_source_kind = 'decision' then p_source_id end
     where d.tenant_id = p_tenant_id
       and d.id is distinct from (case when p_source_kind = 'decision' then p_source_id end)
       and d.emitted_at < v_at
       and d.status = 'proposed'
       and regexp_replace(d.decision_class, '_review$', '') = v_key->>'family'
       and budget_change_key(d.decision_class, d.body)->'subject' = v_key->'subject'
       and (budget_change_key(d.decision_class, d.body)->>'expected') is not null
       and abs((budget_change_key(d.decision_class, d.body)->>'expected')::numeric - v_amount) > v_tol
    returning d.id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_super from superseded;

  return jsonb_build_object('ok', true, 'stale', to_jsonb(v_stale), 'superseded', to_jsonb(v_super));
end $$;

revoke all on function retire_stale_budget_proposals(uuid, text, uuid) from public, anon, authenticated;
grant execute on function retire_stale_budget_proposals(uuid, text, uuid) to service_role;

create or replace function decide_decision_as_actor(
  p_decision_id uuid,
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_action text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_status text;
  v_new_status text;
  v_rows int;
begin
  if p_action not in ('approve', 'reject') then
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
    where user_id = p_actor_user_id and tenant_id = p_tenant_id
  ) then
    raise exception 'not_member: actor is not a member of tenant %', p_tenant_id
      using errcode = '42501';
  end if;

  if v_status <> 'proposed' then
    return jsonb_build_object('changed', false, 'status', v_status);
  end if;

  v_new_status := case when p_action = 'approve' then 'approved' else 'rejected' end;

  update decisions
     set status      = v_new_status,
         approved_by = case when p_action = 'approve' then p_actor_user_id else approved_by end,
         approved_at = case when p_action = 'approve' then now()          else approved_at end,
         rejected_by = case when p_action = 'reject'  then p_actor_user_id else rejected_by end,
         rejected_at = case when p_action = 'reject'  then now()          else rejected_at end
   where id = p_decision_id and status = 'proposed';
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    select status into v_status from decisions where id = p_decision_id;
    return jsonb_build_object('changed', false, 'status', v_status);
  end if;

  return jsonb_build_object('changed', true, 'status', v_new_status);
end $$;

revoke all on function decide_decision_as_actor(uuid, uuid, uuid, text) from public, anon, authenticated;

commit;
