begin;

create or replace function public._email_one_line(p text) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select p is null or p !~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]';
$$;
revoke all on function public._email_one_line(text) from public, anon, authenticated;
grant execute on function public._email_one_line(text) to service_role;

create or replace function public._email_member_edit_untested(p_tenant_id uuid, p_rail text, p_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
begin
  select * into c from public._email_card(p_tenant_id, p_rail, p_id, false);
  if not coalesce(c.o_found, false) or not (c.o_body ? 'member_edited_by') then
    return false;
  end if;
  return not exists (
    select 1 from email_test_sends t
      join tenant_users tu on tu.tenant_id = t.tenant_id and tu.user_id = t.user_id
     where t.tenant_id = p_tenant_id and t.rail = p_rail and t.card_id = p_id and t.variant = 1
       and t.test_sha = public.email_card_test_sha(c.o_body, 1)
       and tu.role in ('owner', 'admin'));
end $$;
revoke all on function public._email_member_edit_untested(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public._email_member_edit_untested(uuid, text, uuid) to service_role;

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
  v_rows int;
  v_role text;
begin
  if p_tenant_id is null or p_id is null or p_user_id is null or p_rail not in ('channel_actions', 'decisions') then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select role into v_role from tenant_users where tenant_id = p_tenant_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_role is null or v_role not in ('owner', 'admin', 'member') then
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
  if exists (select 1 from email_planned_sends s
              where s.tenant_id = p_tenant_id and s.card_rail = p_rail and s.card_id = p_id and s.status = 'scheduled') then
    return jsonb_build_object('ok', false, 'code', 'scheduled_send_pending');
  end if;
  if p_expected_body is null or c.o_body <> p_expected_body then
    return jsonb_build_object('ok', false, 'code', 'card_changed');
  end if;
  if jsonb_typeof(p_sealed) = 'object' and jsonb_typeof(p_sealed->'content') = 'object'
     and (not public._email_one_line(p_sealed->'content'->>'subject')
          or not public._email_one_line(p_sealed->'content'->>'preview_text')) then
    return jsonb_build_object('ok', false, 'code', 'bad_content',
      'message', 'The subject and the preview text must each be on one line: remove the line break or hidden character.');
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
            || jsonb_build_object('edited_by', p_user_id, 'edited_at', now())
            || case when v_role in ('owner', 'admin') then '{}'::jsonb
                    else jsonb_build_object('member_edited_by', p_user_id, 'member_edited_at', now()) end;
  if p_rail = 'channel_actions' then
    update channel_actions set exec_payload = v_body where id = p_id and exec_status is null and approved_by is null;
  else
    update decisions set body = v_body where id = p_id and status = 'proposed' and approved_by is null;
  end if;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return jsonb_build_object('ok', false, 'code', 'not_open'); end if;
  return jsonb_build_object('ok', true, 'test_sha', public.email_card_test_sha(v_body, p_variant));
end $$;
revoke all on function public.edit_email_card_variant(uuid, text, uuid, int, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.edit_email_card_variant(uuid, text, uuid, int, uuid, jsonb, jsonb) to service_role;

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
  if public._email_member_edit_untested(p_tenant_id, 'channel_actions', p_action_id) then
    return jsonb_build_object('ok', false, 'code', 'member_edit_untested');
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
    elsif public._email_member_edit_untested(p_tenant_id, v_row.card_rail, v_row.card_id) then
      v_skip := 'member_edit_untested';
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

create or replace function public.email_list_record_consent(
  p_tenant_id    uuid,
  p_list_id      uuid,
  p_version_id   uuid,
  p_user_id      uuid,
  p_consent_text text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_latest uuid;
  v_done   timestamptz;
  v_role   text;
begin
  if p_tenant_id is null or p_list_id is null or p_version_id is null or p_user_id is null
     or p_consent_text is null or length(trim(p_consent_text)) = 0 then
    raise exception 'email_list_record_consent: null argument' using errcode = '22023';
  end if;
  select tu.role into v_role from public.tenant_users tu
   where tu.tenant_id = p_tenant_id and tu.user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_a_member');
  end if;
  if v_role is null or v_role not in ('owner', 'admin') then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  perform 1 from public.email_lists l
    where l.id = p_list_id and l.tenant_id = p_tenant_id and l.archived_at is null
    for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'list_not_found');
  end if;
  select v.consent_confirmed_at into v_done from public.email_list_versions v
   where v.id = p_version_id and v.list_id = p_list_id and v.tenant_id = p_tenant_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'version_not_found');
  end if;
  if v_done is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_recorded');
  end if;
  select v.id into v_latest from public.email_list_versions v
   where v.list_id = p_list_id and v.tenant_id = p_tenant_id
   order by v.created_at desc, v.id desc limit 1;
  if v_latest is distinct from p_version_id then
    return jsonb_build_object('ok', false, 'reason', 'superseded');
  end if;

  update public.email_list_versions v
     set consent_text = p_consent_text, consent_confirmed_by = p_user_id, consent_confirmed_at = now()
   where v.id = p_version_id and v.list_id = p_list_id and v.tenant_id = p_tenant_id
     and v.consent_confirmed_at is null;
  update public.email_lists l set active_version_id = p_version_id
   where l.id = p_list_id and l.tenant_id = p_tenant_id;
  return jsonb_build_object('ok', true, 'active_version_id', p_version_id);
end $$;
revoke all on function public.email_list_record_consent(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.email_list_record_consent(uuid, uuid, uuid, uuid, text) to service_role;

create or replace function public._email_import_address_ok(p text) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select p is not null and length(p) between 3 and 320
     and p !~ '[\x01-\x20\x7f<>;,"]'
     and p ~ '^[^@]+@[^@]+\.[^@]+$';
$$;
revoke all on function public._email_import_address_ok(text) from public, anon, authenticated;
grant execute on function public._email_import_address_ok(text) to service_role;

create or replace function public.email_list_import_version(
  p_tenant_id   uuid,
  p_list_id     uuid,
  p_list_name   text,
  p_source_kind text,
  p_source_ref  jsonb,
  p_emails      text[],
  p_created_by  uuid
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_norm       text[];
  v_list_id    uuid;
  v_version_id uuid;
  v_count      int;
  v_blocked    int;
begin
  if p_tenant_id is null or p_created_by is null or p_emails is null then
    raise exception 'email_list_import_version: null argument' using errcode = '22023';
  end if;
  if p_source_kind not in ('csv', 'database') then
    raise exception 'email_list_import_version: invalid source' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct lower(trim(e))), '{}'::text[]) into v_norm
    from unnest(p_emails) as e
   where e is not null and length(trim(e)) > 0;
  if coalesce(array_length(v_norm, 1), 0) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_addresses');
  end if;
  if array_length(v_norm, 1) > 10000 then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;
  if exists (select 1 from unnest(v_norm) as e where not public._email_import_address_ok(e)) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_address');
  end if;
  if not exists (select 1 from public.tenant_users tu
                  where tu.tenant_id = p_tenant_id and tu.user_id = p_created_by) then
    return jsonb_build_object('ok', false, 'reason', 'not_a_member');
  end if;

  if p_list_id is not null then
    select l.id into v_list_id from public.email_lists l
     where l.id = p_list_id and l.tenant_id = p_tenant_id and l.archived_at is null
     for update;
    if v_list_id is null then
      return jsonb_build_object('ok', false, 'reason', 'list_not_found');
    end if;
  else
    if p_list_name is null or length(trim(p_list_name)) not between 1 and 120 then
      return jsonb_build_object('ok', false, 'reason', 'invalid_name');
    end if;
    if exists (select 1 from public.email_lists l
                where l.tenant_id = p_tenant_id and l.archived_at is null
                  and lower(trim(l.name)) = lower(trim(p_list_name))) then
      return jsonb_build_object('ok', false, 'reason', 'name_taken');
    end if;
    insert into public.email_lists (tenant_id, name, created_by)
    values (p_tenant_id, trim(p_list_name), p_created_by)
    returning id into v_list_id;
  end if;

  insert into public.email_contacts (tenant_id, email_norm)
  select p_tenant_id, e from unnest(v_norm) as e
  on conflict (tenant_id, email_norm) do nothing;

  v_count := array_length(v_norm, 1);
  insert into public.email_list_versions
    (tenant_id, list_id, source_kind, source_ref, contact_count, created_by)
  values
    (p_tenant_id, v_list_id, p_source_kind, coalesce(p_source_ref, '{}'::jsonb), v_count, p_created_by)
  returning id into v_version_id;

  insert into public.email_list_version_contacts (tenant_id, version_id, contact_id)
  select p_tenant_id, v_version_id, c.id
    from public.email_contacts c
   where c.tenant_id = p_tenant_id and c.email_norm = any (v_norm);

  select count(*) into v_blocked
    from unnest(v_norm) as e
   where public.email_bulk_block_reason(p_tenant_id, e) is not null;

  return jsonb_build_object(
    'ok', true, 'list_id', v_list_id, 'version_id', v_version_id,
    'contact_count', v_count, 'already_blocked', v_blocked);
end $$;
revoke all on function public.email_list_import_version(uuid, uuid, text, text, jsonb, text[], uuid) from public, anon, authenticated;
grant execute on function public.email_list_import_version(uuid, uuid, text, text, jsonb, text[], uuid) to service_role;

commit;
