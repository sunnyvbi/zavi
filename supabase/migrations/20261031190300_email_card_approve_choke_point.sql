
create or replace function approve_channel_action(
  p_tenant_id     uuid,
  p_action_id     uuid,
  p_event_key     text,
  p_actor_user_id uuid default null,
  p_source        text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row     channel_actions%rowtype;
  v_key     text := left(nullif(trim(p_event_key), ''), 200);
  v_attempt int;
begin
  if p_tenant_id is null or p_action_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_key is null then
    return jsonb_build_object('ok', false, 'code', 'event_key_required');
  end if;
  if p_source is not null and p_source not in ('staff', 'cgo') then
    return jsonb_build_object('ok', false, 'code', 'invalid_source');
  end if;

  select * into v_row from channel_actions where id = p_action_id for update;
  if not found or v_row.tenant_id is distinct from p_tenant_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if p_actor_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'approver_required');
  end if;
  if not exists (
    select 1 from tenant_users tu
     where tu.tenant_id = p_tenant_id and tu.user_id = p_actor_user_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if v_row.exec_class is null then
    return jsonb_build_object('ok', false, 'code', 'not_executable');
  end if;

  if v_row.exec_class in ('email_campaign.create_and_send', 'bulk_outbound.send')
     and coalesce(current_setting('zavi.email_card_approve', true), '') <> 'on' then
    return jsonb_build_object('ok', false, 'code', 'email_card_approve_required');
  end if;

  if v_row.exec_status = 'failed'
     and v_row.exec_result->>'bucket' = 'blocked_on_us' then
    return jsonb_build_object('ok', false, 'code', 'exec_blocked_no_retry');
  end if;
  if v_row.exec_status = 'failed'
     and (v_row.exec_result->>'bucket' = 'partial_risk'
          or v_row.exec_result->>'code' in ('exec_partial', 'exec_outcome_unknown')) then
    return jsonb_build_object('ok', false, 'code', 'exec_partial_no_retry');
  end if;
  if exists (select 1 from channel_action_events
              where action_id = p_action_id and event_key = v_key) then
    select count(*) into v_attempt from channel_action_events
     where action_id = p_action_id and event = 'approved';
    return jsonb_build_object('ok', true, 'replayed', true, 'attempt', v_attempt,
                              'exec_class', v_row.exec_class);
  end if;

  if v_row.exec_status in ('queued', 'dispatching') then
    select count(*) into v_attempt from channel_action_events
     where action_id = p_action_id and event = 'approved';
    return jsonb_build_object('ok', true, 'replayed', true, 'queued', true,
                              'attempt', v_attempt,
                              'exec_status', v_row.exec_status);
  end if;
  if v_row.exec_status = 'executed' then
    return jsonb_build_object('ok', false, 'code', 'already_executed');
  end if;
  if v_row.exec_status = 'failed'
     and v_row.exec_result->>'code' in ('exec_partial', 'exec_outcome_unknown') then
    return jsonb_build_object('ok', false, 'code', 'exec_partial_no_retry');
  end if;
  if v_row.status not in ('pending', 'snoozed') then
    return jsonb_build_object('ok', false, 'code', 'illegal_transition',
                              'from', v_row.status, 'to', 'approved');
  end if;

  update channel_actions
     set exec_status        = 'queued',
         exec_result        = null,
         exec_claim_id      = null,
         exec_claimed_at    = null,
         approved_by        = p_actor_user_id,
         approved_by_source = p_source
   where id = p_action_id;

  insert into channel_action_events
    (tenant_id, action_id, event, actor_kind, actor_user_id, event_key)
  values
    (p_tenant_id, p_action_id, 'approved',
     case when p_source = 'cgo' then 'system' else 'founder' end,
     p_actor_user_id, v_key);

  select count(*) into v_attempt from channel_action_events
   where action_id = p_action_id and event = 'approved';

  return jsonb_build_object('ok', true, 'replayed', false, 'attempt', v_attempt,
                            'exec_class', v_row.exec_class);
end $$;

revoke all on function approve_channel_action(uuid, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function approve_channel_action(uuid, uuid, text, uuid, text) to service_role;

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
  v_out      jsonb;
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

  perform set_config('zavi.email_card_approve', 'on', true);
  v_out := approve_channel_action(p_tenant_id, p_action_id, p_event_key, p_actor_user_id, 'cgo');
  perform set_config('zavi.email_card_approve', '', true);
  return v_out;
end $$;

revoke all on function approve_email_campaign_send_as_cgo(uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function approve_email_campaign_send_as_cgo(uuid, uuid, text, uuid) to service_role;

create or replace function decisions_email_send_approve_guard()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_classes constant text[] := array['email_campaign.create_and_send', 'bulk_outbound.send'];
  v_gated   boolean;
begin
  if coalesce(current_setting('zavi.email_card_approve', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.decision_class = any (v_classes)
       and (new.status is distinct from 'proposed' or new.approved_by is not null) then
      raise exception 'email_card_approve_required: an email send is approved only from its email card'
        using errcode = '42501';
    end if;
    return new;
  end if;

  v_gated := coalesce(new.decision_class = any (v_classes), false)
          or coalesce(old.decision_class = any (v_classes), false);
  if not v_gated then
    return new;
  end if;
  if new.decision_class is distinct from old.decision_class
     or (new.approved_by is not null and new.approved_by is distinct from old.approved_by)
     or (old.status = 'proposed'
         and old.approved_by is null
         and new.status in ('approved', 'dispatching', 'acted')) then
    raise exception 'email_card_approve_required: an email send is approved only from its email card'
      using errcode = '42501';
  end if;
  return new;
end $$;

revoke all on function decisions_email_send_approve_guard() from public, anon, authenticated;

drop trigger if exists decisions_email_send_approve_guard on public.decisions;
create trigger decisions_email_send_approve_guard
  before insert or update on public.decisions
  for each row execute function decisions_email_send_approve_guard();
