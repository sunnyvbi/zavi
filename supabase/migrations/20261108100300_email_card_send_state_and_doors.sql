begin;

create or replace function public.email_card_send_facts(p_tenant_id uuid, p_rail text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_card    jsonb;
  v_bulk    jsonb;
  v_results jsonb;
begin
  if p_rail = 'channel_actions' then
    select jsonb_build_object('status', ca.status, 'exec_status', ca.exec_status, 'approved', ca.approved_by is not null,
             'executed_at', ca.executed_at, 'claimed_at', ca.exec_claimed_at, 'code', ca.exec_result->>'code', 'bucket', ca.exec_result->>'bucket',
             'not_sent', coalesce((ca.exec_result->>'not_sent')::boolean, false), 'error', left(ca.exec_result->>'error', 500),
             'receipt', ca.exec_result->'receipt',
             'approved_at', (select max(e.at) from channel_action_events e where e.action_id = ca.id and e.event = 'approved'))
      into v_card
      from channel_actions ca
     where ca.id = p_id and ca.tenant_id = p_tenant_id and ca.exec_class = 'email_campaign.create_and_send';
  elsif p_rail = 'decisions' then
    select jsonb_build_object('status', d.status, 'approved', d.approved_by is not null, 'approved_at', d.approved_at,
             'dispatched_at', d.dispatched_at, 'error', left(d.dispatch_error, 500))
      into v_card
      from decisions d
     where d.id = p_id and d.tenant_id = p_tenant_id and d.decision_class in ('email_campaign.create_and_send', 'bulk_outbound.send');
    select jsonb_build_object('status', b.status, 'hold_reason', b.hold_reason, 'total', b.total, 'sent', b.sent,
             'skipped', b.skipped, 'failed', b.failed, 'unknown', b.unknown, 'hard_bounces', b.hard_bounces,
             'created_at', b.created_at, 'finished_at', b.finished_at, 'next_run_at', b.next_run_at)
      into v_bulk
      from email_bulk_sends b
     where b.decision_id = p_id and b.tenant_id = p_tenant_id;
  end if;
  if v_card is null then return null; end if;
  select jsonb_build_object('sent_count', r.sent_count, 'finished_at', r.finished_at, 'h1', r.h1, 'd7', r.d7,
           'd7_published', r.d7_published_at is not null)
    into v_results
    from email_send_results r
   where r.tenant_id = p_tenant_id and r.rail = p_rail and r.card_id = p_id;
  return jsonb_build_object('card', v_card, 'bulk', v_bulk, 'results', v_results);
end $$;
revoke all on function public.email_card_send_facts(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.email_card_send_facts(uuid, text, uuid) to service_role;

create or replace function approve_email_campaign_send_as_cgo(
  p_tenant_id      uuid,
  p_action_id      uuid,
  p_event_key      text,
  p_actor_user_id  uuid,
  p_approved_count int default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row      channel_actions%rowtype;
  v_tool     text;
  v_audience text;
  v_out      jsonb;
  v_versions boolean;
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
  if v_row.exec_payload ? 'planned_send_id'
     and coalesce(current_setting('zavi.email_plan_fire', true), '') <> 'on' then
    return jsonb_build_object('ok', false, 'code', 'planned_card_deadline_only');
  end if;
  v_tool     := nullif(trim(v_row.exec_payload->>'tool'), '');
  v_audience := nullif(trim(v_row.exec_payload->>'audience_id'), '');
  if v_tool is null or v_audience is null then
    return jsonb_build_object('ok', false, 'code', 'audience_unknown');
  end if;
  if public._email_test_list_marked(p_tenant_id, v_tool || ':' || v_audience) then
    return jsonb_build_object('ok', false, 'code', 'test_list');
  end if;
  v_versions := public._email_card_versions(v_row.exec_payload) > 0;
  if not v_versions then
    return jsonb_build_object('ok', false, 'code', 'redraft_required');
  end if;
  if v_versions and v_row.exec_status is null and (p_approved_count is null or p_approved_count < 1) then
    return jsonb_build_object('ok', false, 'code', 'count_required');
  end if;
  if v_versions and p_approved_count > 1000 then
    return jsonb_build_object('ok', false, 'code', 'audience_over_limit');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cgo_email_send:' || p_tenant_id::text || ':' || v_tool || ':' || v_audience, 0));

  if public._email_list_sent_near(p_tenant_id, v_tool || ':' || v_audience, now(), 'channel_actions', p_action_id) is not null then
    return jsonb_build_object('ok', false, 'code', 'cgo_email_sent_recently');
  end if;

  perform set_config('zavi.email_card_approve', 'on', true);
  v_out := approve_channel_action(p_tenant_id, p_action_id, p_event_key, p_actor_user_id, 'cgo');
  if v_versions and coalesce((v_out->>'ok')::boolean, false) and not coalesce((v_out->>'replayed')::boolean, false) then
    update channel_actions
       set exec_payload = exec_payload || jsonb_build_object('chosen_variant', 1, 'approved_count', p_approved_count)
     where id = p_action_id;
  end if;
  perform set_config('zavi.email_card_approve', '', true);
  return v_out;
end $$;

revoke all on function approve_email_campaign_send_as_cgo(uuid, uuid, text, uuid, int)
  from public, anon, authenticated;
grant execute on function approve_email_campaign_send_as_cgo(uuid, uuid, text, uuid, int) to service_role;

create or replace function public.fire_email_planned_send(
  p_tenant_id uuid, p_id uuid, p_gen int, p_unattended jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key   text;
  v_row   email_planned_sends%rowtype;
  c       record;
  v_out   jsonb;
  v_owner uuid;
  v_near  timestamptz;
  v_count int;
  v_event jsonb;
  v_skip  text;
  v_class text;
begin
  select list_key into v_key from email_planned_sends where id = p_id and tenant_id = p_tenant_id;
  if v_key is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  perform public._email_list_lock(p_tenant_id, v_key);
  select * into v_row from email_planned_sends where id = p_id and tenant_id = p_tenant_id for update;
  if v_row.schedule_gen is distinct from p_gen or v_row.status not in ('planned', 'drafting', 'ready', 'scheduled') then
    return jsonb_build_object('ok', true, 'outcome', 'noop', 'status', v_row.status);
  end if;
  if v_row.planned_at > now() then
    return jsonb_build_object('ok', true, 'outcome', 'not_yet');
  end if;
  if v_row.vetoed_at is null and v_row.card_id is null and v_row.status in ('planned', 'drafting')
     and v_row.planned_at > now() - interval '1 hour'
     and exists (select 1 from email_plan_jobs j where j.tenant_id = p_tenant_id and j.item_id = p_id
                    and j.kind = 'draft' and j.state <> 'done') then
    return jsonb_build_object('ok', true, 'outcome', 'not_yet');
  end if;

  if v_row.vetoed_at is not null then
    v_skip := 'vetoed';
  elsif public.email_send_paused(p_tenant_id) then
    v_skip := 'paused';
  elsif v_row.card_id is null then
    v_skip := 'no_draft';
  elsif public._email_test_list_marked(p_tenant_id, v_key) then
    v_skip := 'test_list';
  else
    v_near := public._email_list_sent_near(p_tenant_id, v_key, now(), v_row.card_rail, v_row.card_id);
    if v_near is not null then v_skip := 'list_sent_recently'; end if;
  end if;

  if v_skip is null and v_row.status = 'scheduled' then
    select * into c from public._email_card(p_tenant_id, v_row.card_rail, v_row.card_id, false);
    if v_row.sched_card_id is distinct from v_row.card_id or v_row.sched_version is distinct from v_row.content_version
       or not coalesce(c.o_open, false)
       or public.email_card_test_sha(c.o_body, v_row.sched_variant) is distinct from v_row.sched_sha
       or public._email_plan_account(c.o_class, c.o_body) is distinct from v_row.sched_account then
      v_skip := 'changed_after_approval';
    elsif coalesce(public._email_plan_role(p_tenant_id, v_row.sched_by), '') not in ('owner', 'admin') then
      v_skip := 'approver_gone';
    else
      v_out := public.approve_email_card(p_tenant_id, v_row.card_rail, v_row.card_id, v_row.sched_variant, v_row.sched_by,
                                         'plan:' || p_id || ':g' || v_row.schedule_gen, v_row.sched_count);
      if not coalesce((v_out->>'ok')::boolean, false) then
        v_skip := coalesce(v_out->>'code', 'refused');
      end if;
    end if;
  elsif v_skip is null then
    if not coalesce((p_unattended->>'allow')::boolean, false) then
      v_skip := 'not_approved_in_time';
    else
      v_count := (p_unattended->>'count')::int;
      select tu.user_id into v_owner from tenant_users tu
       where tu.tenant_id = p_tenant_id and tu.role = 'owner' order by tu.user_id limit 1;
      select * into c from public._email_card(p_tenant_id, v_row.card_rail, v_row.card_id, true);
      if v_count is null or v_count < 1 or v_count > 1000 then
        v_skip := 'audience_over_limit';
      elsif v_owner is null or not coalesce(c.o_open, false) then
        v_skip := 'not_open';
      elsif v_row.card_rail = 'channel_actions' then
        perform set_config('zavi.email_plan_fire', 'on', true);
        v_out := public.approve_email_campaign_send_as_cgo(p_tenant_id, v_row.card_id, 'plan:' || p_id || ':g' || v_row.schedule_gen, v_owner, v_count);
        perform set_config('zavi.email_plan_fire', '', true);
        if not coalesce((v_out->>'ok')::boolean, false) then v_skip := coalesce(v_out->>'code', 'refused'); end if;
      else
        if c.o_class is distinct from 'bulk_outbound.send' or public._email_card_versions(c.o_body) = 0 then
          v_skip := 'redraft_required';
        else
          perform set_config('zavi.email_card_approve', 'on', true);
          perform set_config('zavi.email_plan_fire', 'on', true);
          update decisions
             set body = body || jsonb_build_object('chosen_variant', 1, 'approved_count', v_count),
                 status = 'approved', approved_by = v_owner, approved_at = now(), approved_by_source = 'plan_autopilot'
           where id = v_row.card_id and tenant_id = p_tenant_id and status = 'proposed' and approved_by is null;
          perform set_config('zavi.email_plan_fire', '', true);
          perform set_config('zavi.email_card_approve', '', true);
          if not found then v_skip := 'not_open'; else v_out := jsonb_build_object('ok', true, 'status', 'approved'); end if;
        end if;
      end if;
      if v_skip is null then
        update email_planned_sends set unattended = true where id = p_id;
      end if;
    end if;
  end if;

  if v_skip is not null then
    update email_planned_sends
       set status = case when v_skip in ('test_list') then 'blocked' else 'skipped' end, status_reason = v_skip,
           sched_variant = null, sched_count = null, sched_by = null, sched_sha = null, sched_version = null,
           sched_card_id = null, sched_account = null, sched_at = null, updated_at = now()
     where id = p_id;
    return jsonb_build_object('ok', true, 'outcome', 'skipped', 'reason', v_skip);
  end if;

  if v_row.card_rail = 'channel_actions' then
    v_event := jsonb_build_object('id', 'approve:' || v_row.card_id || ':' || coalesce((v_out->>'attempt')::int, 1),
                                  'name', 'channel-action.approved', 'data', jsonb_build_object('action_id', v_row.card_id));
  else
    select decision_class into v_class from decisions where id = v_row.card_id and tenant_id = p_tenant_id;
    v_event := jsonb_build_object('id', 'approve:' || v_row.card_id, 'name', 'decision.approved',
                                  'data', jsonb_build_object('decision_id', v_row.card_id, 'tenant_id', p_tenant_id, 'decision_class', v_class));
  end if;
  insert into email_plan_outbox (tenant_id, item_id, event_id, event_name, event_data)
  values (p_tenant_id, p_id, v_event->>'id', v_event->>'name', v_event->'data')
  on conflict (tenant_id, event_id) do nothing;
  return jsonb_build_object('ok', true, 'outcome', 'queued', 'event', v_event, 'unattended', v_row.status = 'ready');
end $$;
revoke all on function public.fire_email_planned_send(uuid, uuid, int, jsonb) from public, anon, authenticated;
grant execute on function public.fire_email_planned_send(uuid, uuid, int, jsonb) to service_role;

commit;
