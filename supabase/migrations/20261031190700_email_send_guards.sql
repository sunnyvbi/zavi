
begin;

create or replace function decisions_email_send_approve_guard()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_classes constant text[] := array['email_campaign.create_and_send', 'bulk_outbound.send'];
  v_go      constant text[] := array['approved', 'dispatching', 'acted'];
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
     or (new.approved_by is not null and new.approved_by is distinct from old.approved_by) then
    raise exception 'email_card_approve_required: an email send is approved only from its email card'
      using errcode = '42501';
  end if;
  if new.status = any (v_go) and new.status is distinct from old.status
     and not coalesce(old.approved_by is not null
              and (old.status in ('approved', 'dispatching', 'acted', 'dispatch_failed')
                   or (old.status = 'proposed' and new.status = 'dispatching')), false) then
    raise exception 'email_card_approve_required: an email send is approved only from its email card'
      using errcode = '42501';
  end if;
  return new;
end $$;

revoke all on function decisions_email_send_approve_guard() from public, anon, authenticated;

create or replace function channel_actions_email_send_guard()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_class constant text := 'email_campaign.create_and_send';
begin
  if coalesce(current_setting('zavi.email_card_approve', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.exec_class = v_class
       and (new.exec_status is not null or new.approved_by is not null or new.approved_by_source is not null) then
      raise exception 'email_card_approve_required: an email send is approved only from its email card'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if not (coalesce(new.exec_class = v_class, false) or coalesce(old.exec_class = v_class, false)) then
    return new;
  end if;
  if new.exec_class is distinct from old.exec_class
     or (new.approved_by is not null and new.approved_by is distinct from old.approved_by)
     or (new.approved_by_source is distinct from old.approved_by_source and new.approved_by_source is not null) then
    raise exception 'email_card_approve_required: an email send is approved only from its email card'
      using errcode = '42501';
  end if;
  if new.exec_status is distinct from old.exec_status and not coalesce(
       new.exec_status is null
    or new.exec_status = 'failed'
    or (new.exec_status = 'dispatching' and old.exec_status = 'queued')
    or (new.exec_status = 'queued' and old.exec_status = 'dispatching')
    or (new.exec_status = 'executed' and old.exec_status in ('dispatching', 'failed') and old.approved_by is not null),
    false
  ) then
    raise exception 'email_card_approve_required: an email send is approved only from its email card'
      using errcode = '42501';
  end if;
  if old.exec_status in ('queued', 'dispatching', 'executed') and new.exec_payload is distinct from old.exec_payload then
    raise exception 'email_card_approve_required: an approved email is sent as approved'
      using errcode = '42501';
  end if;
  return new;
end $$;

revoke all on function channel_actions_email_send_guard() from public, anon, authenticated;

drop trigger if exists channel_actions_email_send_guard on public.channel_actions;
create trigger channel_actions_email_send_guard
  before insert or update on public.channel_actions
  for each row execute function channel_actions_email_send_guard();

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
  v_tool     := nullif(trim(v_row.exec_payload->>'tool'), '');
  v_audience := nullif(trim(v_row.exec_payload->>'audience_id'), '');
  if v_tool is null or v_audience is null then
    return jsonb_build_object('ok', false, 'code', 'audience_unknown');
  end if;
  v_versions := public._email_card_versions(v_row.exec_payload) > 0;
  if v_versions and v_row.exec_status is null and (p_approved_count is null or p_approved_count < 1) then
    return jsonb_build_object('ok', false, 'code', 'count_required');
  end if;
  if v_versions and p_approved_count > 1000 then
    return jsonb_build_object('ok', false, 'code', 'audience_over_limit');
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

create or replace function public.replace_email_card(
  p_tenant_id uuid,
  p_rail      text,
  p_id        uuid,
  p_new_rail  text,
  p_new_id    uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
  n record;
  v_ptr jsonb;
begin
  if p_tenant_id is null or p_id is null or p_new_id is null or p_id = p_new_id
     or p_new_rail not in ('channel_actions', 'decisions') then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into n from public._email_card(p_tenant_id, p_new_rail, p_new_id, false);
  if not coalesce(n.o_found, false) then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  select * into c from public._email_card(p_tenant_id, p_rail, p_id, true);
  if not c.o_found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if not c.o_open or c.o_status = 'failed' then
    return jsonb_build_object('ok', true, 'replaced', false, 'status', c.o_status);
  end if;
  v_ptr := jsonb_build_object('replaced_by', jsonb_build_object('rail', p_new_rail, 'id', p_new_id));
  if p_rail = 'channel_actions' then
    update channel_actions
       set status = 'rejected', status_at = now(), note = 'replaced_by_newer_draft',
           exec_payload = exec_payload || v_ptr
     where id = p_id;
    insert into channel_action_events (tenant_id, action_id, event, actor_kind, note, event_key)
    values (p_tenant_id, p_id, 'rejected', 'system', 'replaced_by_newer_draft', 'replaced:' || p_new_id::text)
    on conflict (action_id, event_key) do nothing;
  else
    update decisions
       set status = 'rejected', rejected_at = now(), body = body || v_ptr || jsonb_build_object('rejected_reason', 'replaced_by_newer_draft')
     where id = p_id and status = 'proposed';
  end if;
  return jsonb_build_object('ok', true, 'replaced', true);
end $$;
revoke all on function public.replace_email_card(uuid, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.replace_email_card(uuid, text, uuid, text, uuid) to service_role;

create or replace function public.edit_email_card_variant(
  p_tenant_id     uuid,
  p_rail          text,
  p_id            uuid,
  p_variant       int,
  p_user_id       uuid,
  p_expected_body jsonb,
  p_sealed        jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
  v_n int;
  v_body jsonb;
  v_rv text;
begin
  if p_tenant_id is null or p_id is null or p_user_id is null or p_rail not in ('channel_actions', 'decisions') then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_user_id
                    and role in ('owner', 'admin', 'member')) then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  select * into c from public._email_card(p_tenant_id, p_rail, p_id, true);
  if not c.o_found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  v_n := public._email_card_versions(c.o_body);
  if v_n = 0 then return jsonb_build_object('ok', false, 'code', 'redraft_required'); end if;
  if not c.o_open or c.o_status = 'failed' then
    return jsonb_build_object('ok', false, 'code', 'not_open', 'status', c.o_status);
  end if;
  if p_variant is null or p_variant < 1 or p_variant > v_n then
    return jsonb_build_object('ok', false, 'code', 'bad_variant');
  end if;
  if p_expected_body is null or c.o_body <> p_expected_body then
    return jsonb_build_object('ok', false, 'code', 'card_changed');
  end if;
  v_rv := c.o_body->>'renderer_version';
  if jsonb_typeof(p_sealed) <> 'object' or jsonb_typeof(p_sealed->'content') <> 'object'
     or coalesce(p_sealed->>'html', '') = '' or coalesce(p_sealed->>'text', '') = ''
     or coalesce(p_sealed->>'render_sha', '') !~ '^[0-9a-f]{64}$'
     or encode(sha256(convert_to(coalesce(v_rv, ''), 'UTF8') || '\x00'::bytea || convert_to(p_sealed->>'html', 'UTF8')
                      || '\x00'::bytea || convert_to(p_sealed->>'text', 'UTF8')), 'hex') <> p_sealed->>'render_sha' then
    return jsonb_build_object('ok', false, 'code', 'bad_variant');
  end if;
  v_body := jsonb_set(c.o_body, array['variants', (p_variant - 1)::text], p_sealed)
            || jsonb_build_object('edited_by', p_user_id, 'edited_at', now());
  if p_rail = 'channel_actions' then
    update channel_actions set exec_payload = v_body where id = p_id;
  else
    update decisions set body = v_body where id = p_id and status = 'proposed';
  end if;
  return jsonb_build_object('ok', true, 'test_sha', public.email_card_test_sha(v_body, p_variant));
end $$;
revoke all on function public.edit_email_card_variant(uuid, text, uuid, int, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.edit_email_card_variant(uuid, text, uuid, int, uuid, jsonb, jsonb) to service_role;

commit;
