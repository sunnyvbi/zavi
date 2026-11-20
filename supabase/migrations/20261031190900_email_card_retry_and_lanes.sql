
begin;

drop function if exists public._email_card(uuid, text, uuid, boolean);
create or replace function public._email_card(p_tenant_id uuid, p_rail text, p_id uuid, p_lock boolean,
  out o_found boolean, out o_class text, out o_body jsonb, out o_open boolean, out o_status text,
  out o_approved boolean, out o_exec_result jsonb)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ca channel_actions%rowtype;
  v_d  decisions%rowtype;
begin
  o_found := false;
  o_open := false;
  o_approved := false;
  if p_rail = 'channel_actions' then
    if p_lock then
      select * into v_ca from channel_actions where id = p_id for update;
    else
      select * into v_ca from channel_actions where id = p_id;
    end if;
    if not found or v_ca.tenant_id is distinct from p_tenant_id
       or v_ca.exec_class is distinct from 'email_campaign.create_and_send' then
      return;
    end if;
    o_found := true;
    o_class := v_ca.exec_class;
    o_body := v_ca.exec_payload;
    o_status := coalesce(v_ca.exec_status, v_ca.status);
    o_open := coalesce(v_ca.status in ('pending', 'snoozed') and v_ca.exec_status is null and v_ca.approved_by is null, false);
    o_approved := v_ca.approved_by is not null;
    o_exec_result := v_ca.exec_result;
  elsif p_rail = 'decisions' then
    if p_lock then
      select * into v_d from decisions where id = p_id for update;
    else
      select * into v_d from decisions where id = p_id;
    end if;
    if not found or v_d.tenant_id is distinct from p_tenant_id
       or v_d.decision_class is null
       or v_d.decision_class not in ('email_campaign.create_and_send', 'bulk_outbound.send') then
      return;
    end if;
    o_found := true;
    o_class := v_d.decision_class;
    o_body := v_d.body;
    o_status := v_d.status;
    o_open := coalesce(v_d.status = 'proposed' and v_d.approved_by is null, false);
    o_approved := v_d.approved_by is not null;
  end if;
end $$;
revoke all on function public._email_card(uuid, text, uuid, boolean) from public, anon, authenticated;

create or replace function public._email_card_retry(
  p_tenant_id uuid, p_id uuid, p_actor_user_id uuid, p_event_key text, p_approved_count int
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row     channel_actions%rowtype;
  v_key     text := left(nullif(trim(coalesce(p_event_key, '')), ''), 200);
  v_attempt int;
begin
  select * into v_row from channel_actions where id = p_id and tenant_id = p_tenant_id for update;
  if not found or v_row.approved_by is null then
    return jsonb_build_object('ok', false, 'code', 'not_open');
  end if;
  if v_key is null then return jsonb_build_object('ok', false, 'code', 'event_key_required'); end if;
  if exists (select 1 from channel_action_events where action_id = p_id and event_key = v_key) then
    select count(*) into v_attempt from channel_action_events where action_id = p_id and event = 'approved';
    return jsonb_build_object('ok', true, 'replayed', true, 'attempt', v_attempt, 'exec_status', v_row.exec_status);
  end if;
  if v_row.exec_status in ('queued', 'dispatching') then
    select count(*) into v_attempt from channel_action_events where action_id = p_id and event = 'approved';
    return jsonb_build_object('ok', true, 'replayed', true, 'queued', true, 'attempt', v_attempt, 'exec_status', v_row.exec_status);
  end if;
  if v_row.exec_status is distinct from 'failed' or v_row.status not in ('pending', 'snoozed') then
    return jsonb_build_object('ok', false, 'code', 'not_open', 'status', coalesce(v_row.exec_status, v_row.status));
  end if;
  if not public._email_card_retryable(v_row.exec_result) then
    return jsonb_build_object('ok', false, 'code', 'exec_partial_no_retry');
  end if;
  if p_approved_count is null or p_approved_count < 1 then
    return jsonb_build_object('ok', false, 'code', 'count_required');
  end if;
  perform set_config('zavi.email_card_approve', 'on', true);
  update channel_actions
     set exec_status     = 'queued',
         exec_result     = null,
         exec_claim_id   = null,
         exec_claimed_at = null,
         exec_payload    = exec_payload || jsonb_build_object('approved_count', p_approved_count)
   where id = p_id;
  insert into channel_action_events (tenant_id, action_id, event, actor_kind, actor_user_id, event_key)
  values (p_tenant_id, p_id, 'approved', 'founder', p_actor_user_id, v_key);
  perform set_config('zavi.email_card_approve', '', true);
  select count(*) into v_attempt from channel_action_events where action_id = p_id and event = 'approved';
  return jsonb_build_object('ok', true, 'replayed', false, 'attempt', v_attempt, 'exec_class', v_row.exec_class);
end $$;
revoke all on function public._email_card_retry(uuid, uuid, uuid, text, int) from public, anon, authenticated;

create or replace function public._email_card_retryable(p_result jsonb) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_result->>'bucket', '') not in ('blocked_on_us', 'partial_risk')
     and coalesce(p_result->>'code', '') not in ('exec_partial', 'exec_outcome_unknown')
$$;
revoke all on function public._email_card_retryable(jsonb) from public, anon, authenticated;

create or replace function public.approve_email_card(
  p_tenant_id      uuid,
  p_rail           text,
  p_id             uuid,
  p_variant        int,
  p_actor_user_id  uuid,
  p_event_key      text,
  p_approved_count int
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c     record;
  v_sha text;
  v_out jsonb;
begin
  if p_tenant_id is null or p_id is null or p_actor_user_id is null or p_rail not in ('channel_actions', 'decisions') then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into c from public._email_card(p_tenant_id, p_rail, p_id, true);
  if not c.o_found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if public._email_card_versions(c.o_body) = 0 then
    return jsonb_build_object('ok', false, 'code', 'redraft_required');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id
                    and role in ('owner', 'admin')) then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  if p_variant is null or p_variant < 1 or p_variant > public._email_card_versions(c.o_body) then
    return jsonb_build_object('ok', false, 'code', 'bad_variant');
  end if;
  if not c.o_open then
    if not c.o_approved or (c.o_body->>'chosen_variant')::int is distinct from p_variant then
      return jsonb_build_object('ok', false, 'code', 'not_open', 'status', c.o_status);
    end if;
    if p_rail = 'channel_actions' then
      return public._email_card_retry(p_tenant_id, p_id, p_actor_user_id, p_event_key, p_approved_count);
    end if;
    if c.o_status in ('approved', 'dispatching') then
      return jsonb_build_object('ok', true, 'changed', false, 'status', c.o_status, 'class', c.o_class);
    end if;
    return jsonb_build_object('ok', false, 'code', 'not_open', 'status', c.o_status);
  end if;
  v_sha := public.email_card_test_sha(c.o_body, p_variant);
  if not exists (select 1 from email_test_sends t
                   join tenant_users tu on tu.tenant_id = t.tenant_id and tu.user_id = t.user_id
                  where t.tenant_id = p_tenant_id and t.rail = p_rail and t.card_id = p_id
                    and t.variant = p_variant and t.test_sha = v_sha and tu.role in ('owner', 'admin')) then
    return jsonb_build_object('ok', false, 'code', 'test_required');
  end if;
  if p_approved_count is null or p_approved_count < 1 then
    return jsonb_build_object('ok', false, 'code', 'count_required');
  end if;

  perform set_config('zavi.email_card_approve', 'on', true);
  if p_rail = 'channel_actions' then
    v_out := approve_channel_action(p_tenant_id, p_id, coalesce(p_event_key, 'email-card'), p_actor_user_id, null);
    if coalesce((v_out->>'ok')::boolean, false) then
      update channel_actions
         set exec_payload = exec_payload || jsonb_build_object('chosen_variant', p_variant, 'approved_count', p_approved_count)
       where id = p_id;
    end if;
  else
    update decisions
       set body        = body || jsonb_build_object('chosen_variant', p_variant, 'approved_count', p_approved_count),
           status      = 'approved',
           approved_by = p_actor_user_id,
           approved_at = now()
     where id = p_id and status = 'proposed';
    v_out := jsonb_build_object('ok', true, 'changed', true, 'status', 'approved', 'class', c.o_class);
  end if;
  perform set_config('zavi.email_card_approve', '', true);
  return v_out;
end $$;
revoke all on function public.approve_email_card(uuid, text, uuid, int, uuid, text, int) from public, anon, authenticated;
grant execute on function public.approve_email_card(uuid, text, uuid, int, uuid, text, int) to service_role;

create or replace function public.email_card_view_state(
  p_tenant_id uuid, p_rail text, p_id uuid, p_user_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
  v_role text;
  v_n int;
  v_tests jsonb := '[]'::jsonb;
  v_sha text;
begin
  select role into v_role from tenant_users where tenant_id = p_tenant_id and user_id = p_user_id;
  if v_role is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  select * into c from public._email_card(p_tenant_id, p_rail, p_id, false);
  if not c.o_found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  v_n := public._email_card_versions(c.o_body);
  for i in 1..v_n loop
    v_sha := public.email_card_test_sha(c.o_body, i);
    v_tests := v_tests || jsonb_build_object(
      'variant', i,
      'tested_by_me', exists (select 1 from email_test_sends t
                               where t.tenant_id = p_tenant_id and t.rail = p_rail and t.card_id = p_id
                                 and t.variant = i and t.test_sha = v_sha and t.user_id = p_user_id),
      'tested_by_approver', exists (select 1 from email_test_sends t
                                     join tenant_users tu on tu.tenant_id = t.tenant_id and tu.user_id = t.user_id
                                    where t.tenant_id = p_tenant_id and t.rail = p_rail and t.card_id = p_id
                                      and t.variant = i and t.test_sha = v_sha and tu.role in ('owner', 'admin')));
  end loop;
  return jsonb_build_object('ok', true, 'class', c.o_class, 'body', c.o_body, 'open', c.o_open,
                            'status', c.o_status, 'role', v_role, 'versions', v_n, 'tests', v_tests,
                            'retryable', coalesce(p_rail = 'channel_actions' and c.o_status = 'failed' and c.o_approved
                                                  and public._email_card_retryable(c.o_exec_result), false),
                            'failure_reason', case when c.o_status = 'failed' then left(c.o_exec_result->>'error', 500) end);
end $$;
revoke all on function public.email_card_view_state(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_card_view_state(uuid, text, uuid, uuid) to service_role;

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
  v_rows int;
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
     where id = p_id and exec_status is null and approved_by is null;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then return jsonb_build_object('ok', true, 'replaced', false); end if;
    insert into channel_action_events (tenant_id, action_id, event, actor_kind, note, event_key)
    values (p_tenant_id, p_id, 'rejected', 'system', 'replaced_by_newer_draft', 'replaced:' || p_new_id::text)
    on conflict (action_id, event_key) do nothing;
  else
    update decisions
       set status = 'rejected', rejected_at = now(), body = body || v_ptr || jsonb_build_object('rejected_reason', 'replaced_by_newer_draft')
     where id = p_id and status = 'proposed' and approved_by is null;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then return jsonb_build_object('ok', true, 'replaced', false); end if;
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
  v_rows int;
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

create or replace function decisions_email_send_approve_guard()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_classes constant text[] := array['email_campaign.create_and_send', 'bulk_outbound.send'];
  v_go      constant text[] := array['approved', 'dispatching', 'acted'];
  v_gated   boolean;
begin
  if tg_op = 'UPDATE' and old.approved_by is not null
     and coalesce(old.decision_class = any (v_classes), false)
     and (new.approved_by is distinct from old.approved_by or new.approved_by_source is distinct from old.approved_by_source) then
    raise exception 'email_card_approve_required: an approval is never rewritten'
      using errcode = '42501';
  end if;
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
     or new.approved_by is distinct from old.approved_by
     or new.approved_by_source is distinct from old.approved_by_source
     or (old.approved_by is not null and new.body is distinct from old.body) then
    raise exception 'email_card_approve_required: an email send is approved only from its email card'
      using errcode = '42501';
  end if;
  if new.status = any (v_go) and new.status is distinct from old.status
     and not coalesce(old.approved_by is not null
              and ((old.status = 'approved' and new.status = 'dispatching')
                   or (old.status = 'proposed' and new.status = 'dispatching')
                   or (old.status = 'dispatching' and new.status = 'acted')), false) then
    raise exception 'email_card_approve_required: an email send is approved only from its email card'
      using errcode = '42501';
  end if;
  if new.status = 'proposed' and old.status is distinct from 'proposed' and old.approved_by is not null
     and old.status is distinct from 'dispatching' then
    raise exception 'email_card_approve_required: an approved email send does not go back to proposed'
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
  if tg_op = 'UPDATE' and old.approved_by is not null and coalesce(old.exec_class = v_class, false)
     and (new.approved_by is distinct from old.approved_by or new.approved_by_source is distinct from old.approved_by_source) then
    raise exception 'email_card_approve_required: an approval is never rewritten'
      using errcode = '42501';
  end if;
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
     or new.approved_by is distinct from old.approved_by
     or new.approved_by_source is distinct from old.approved_by_source then
    raise exception 'email_card_approve_required: an email send is approved only from its email card'
      using errcode = '42501';
  end if;
  if new.exec_status is distinct from old.exec_status and not coalesce(
    (new.exec_status is null and old.approved_by is null and old.exec_status not in ('queued', 'dispatching', 'executed'))
    or (new.exec_status = 'failed' and old.exec_status in ('queued', 'dispatching'))
    or (new.exec_status = 'dispatching' and old.exec_status = 'queued')
    or (new.exec_status = 'queued' and old.exec_status = 'dispatching')
    or (new.exec_status = 'executed' and old.exec_status in ('dispatching', 'failed') and old.approved_by is not null),
    false
  ) then
    raise exception 'email_card_approve_required: an email send is approved only from its email card'
      using errcode = '42501';
  end if;
  if old.exec_status is not null or old.approved_by is not null then
    if new.exec_payload is distinct from old.exec_payload then
      raise exception 'email_card_approve_required: an approved email is sent as approved'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

revoke all on function channel_actions_email_send_guard() from public, anon, authenticated;

commit;
