begin;

create or replace function channel_actions_email_send_guard()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_class constant text := 'email_campaign.create_and_send';
begin
  if tg_op = 'UPDATE' and old.approved_by is not null and coalesce(old.exec_class = v_class, false)
     and (new.approved_by is distinct from old.approved_by or new.approved_by_source is distinct from old.approved_by_source)
     and not coalesce(current_setting('zavi.email_card_takeover', true) = 'on'
                      and old.approved_by_source = 'cgo' and new.approved_by_source is null and new.approved_by is not null
                      and old.exec_status = 'failed' and new.exec_status = 'queued', false) then
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

create or replace function public._email_card_retry(
  p_tenant_id uuid, p_id uuid, p_actor_user_id uuid, p_event_key text, p_approved_count int, p_variant int
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row      channel_actions%rowtype;
  v_key      text := left(nullif(trim(coalesce(p_event_key, '')), ''), 200);
  v_attempt  int;
  v_refusal  text;
  v_takeover boolean;
  v_variant  int;
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
  v_takeover := v_row.approved_by_source is not distinct from 'cgo';
  v_variant := (v_row.exec_payload->>'chosen_variant')::int;
  if p_variant is distinct from v_variant and not v_takeover then
    return jsonb_build_object('ok', false, 'code', 'not_open', 'status', coalesce(v_row.exec_status, v_row.status));
  end if;
  if v_row.exec_status in ('queued', 'dispatching') then
    select count(*) into v_attempt from channel_action_events where action_id = p_id and event = 'approved';
    return jsonb_build_object('ok', true, 'replayed', true, 'queued', true, 'attempt', v_attempt, 'exec_status', v_row.exec_status);
  end if;
  v_refusal := public._email_card_retry_refusal(v_row.status, v_row.exec_status, v_row.approved_by is not null, v_row.exec_result);
  if v_refusal = 'not_open' then
    return jsonb_build_object('ok', false, 'code', v_refusal, 'status', coalesce(v_row.exec_status, v_row.status));
  elsif v_refusal is not null then
    return jsonb_build_object('ok', false, 'code', v_refusal);
  end if;
  if p_approved_count is null or p_approved_count < 1 then
    return jsonb_build_object('ok', false, 'code', 'count_required');
  end if;
  if v_takeover then
    if p_variant is null or p_variant < 1 or p_variant > public._email_card_versions(v_row.exec_payload) then
      return jsonb_build_object('ok', false, 'code', 'bad_variant');
    end if;
    if not exists (select 1 from email_test_sends t
                     join tenant_users tu on tu.tenant_id = t.tenant_id and tu.user_id = t.user_id
                    where t.tenant_id = p_tenant_id and t.rail = 'channel_actions' and t.card_id = p_id
                      and t.variant = p_variant and t.test_sha = public.email_card_test_sha(v_row.exec_payload, p_variant)
                      and tu.role in ('owner', 'admin')) then
      return jsonb_build_object('ok', false, 'code', 'test_required');
    end if;
    perform set_config('zavi.email_card_takeover', 'on', true);
  end if;
  perform set_config('zavi.email_card_approve', 'on', true);
  update channel_actions
     set exec_status        = 'queued',
         exec_result        = null,
         exec_claim_id      = null,
         exec_claimed_at    = null,
         exec_payload       = exec_payload || jsonb_build_object('approved_count', p_approved_count)
                              || case when v_takeover then jsonb_build_object('chosen_variant', p_variant) else '{}'::jsonb end,
         approved_by        = case when v_takeover then p_actor_user_id else approved_by end,
         approved_by_source = case when v_takeover then null else approved_by_source end
   where id = p_id;
  insert into channel_action_events (tenant_id, action_id, event, actor_kind, actor_user_id, event_key)
  values (p_tenant_id, p_id, 'approved', 'founder', p_actor_user_id, v_key);
  perform set_config('zavi.email_card_approve', '', true);
  perform set_config('zavi.email_card_takeover', '', true);
  select count(*) into v_attempt from channel_action_events where action_id = p_id and event = 'approved';
  return jsonb_build_object('ok', true, 'replayed', false, 'attempt', v_attempt, 'exec_class', v_row.exec_class,
                            'taken_over', v_takeover);
end $$;
revoke all on function public._email_card_retry(uuid, uuid, uuid, text, int, int) from public, anon, authenticated;

create or replace function public._email_redispatch_released(p_tenant_id uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_d   decisions%rowtype;
  v_key text;
begin
  select * into v_d from decisions where id = p_id and tenant_id = p_tenant_id for update;
  if not found or v_d.decision_class not in ('email_campaign.create_and_send', 'bulk_outbound.send')
     or v_d.status is distinct from 'proposed' or v_d.approved_by is null then
    return jsonb_build_object('ok', false, 'code', 'not_open', 'status', v_d.status);
  end if;
  if public.email_send_paused(p_tenant_id) then
    return jsonb_build_object('ok', false, 'code', 'email_paused');
  end if;
  v_key := 'r' || floor(extract(epoch from coalesce(v_d.dispatched_at, v_d.approved_at, now())) * 1000)::bigint::text;
  perform set_config('zavi.email_card_approve', 'on', true);
  update decisions set status = 'approved', dispatch_error = 'email_redispatch:' || v_key where id = p_id and status = 'proposed';
  perform set_config('zavi.email_card_approve', '', true);
  return jsonb_build_object('ok', true, 'changed', false, 'status', 'approved', 'redispatch_key', v_key);
end $$;
revoke all on function public._email_redispatch_released(uuid, uuid) from public, anon, authenticated;

create or replace function public.email_redispatch_released_sweep(p_limit int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r     record;
  v     jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  for r in
    select d.id, d.tenant_id, d.decision_class, d.status, d.approved_at, d.dispatched_at, d.approved_by, d.dispatch_error
      from decisions d
     where d.decision_class in ('email_campaign.create_and_send', 'bulk_outbound.send')
       and ((d.status = 'proposed' and d.approved_by is not null)
         or (d.status = 'approved' and d.dispatch_error like 'email_redispatch:r%'))
       and coalesce(d.dispatched_at, d.approved_at, now()) < now() - interval '5 minutes'
     order by d.dispatched_at nulls first, d.id
     limit greatest(1, least(coalesce(p_limit, 50), 200))
     for update skip locked
  loop
    if coalesce(r.approved_at, r.dispatched_at) < now() - interval '24 hours' then
      update decisions
         set status = 'dispatch_failed',
             dispatch_error = 'Zavi could not start this send within a day of its approval, so it did not send it. Ask Zavi for a new draft.'
       where id = r.id and status in ('proposed', 'approved');
      v_out := v_out || jsonb_build_object('action', 'expired', 'tenant_id', r.tenant_id, 'decision_id', r.id,
                                           'decision_class', r.decision_class);
    elsif r.status = 'approved' then
      v_out := v_out || jsonb_build_object('action', 'redispatch', 'tenant_id', r.tenant_id, 'decision_id', r.id,
                                           'decision_class', r.decision_class,
                                           'redispatch_key', substring(r.dispatch_error from length('email_redispatch:') + 1));
    elsif not public.email_send_paused(r.tenant_id) then
      v := public._email_redispatch_released(r.tenant_id, r.id);
      if coalesce((v->>'ok')::boolean, false) then
        v_out := v_out || jsonb_build_object('action', 'redispatch', 'tenant_id', r.tenant_id, 'decision_id', r.id,
                                             'decision_class', r.decision_class, 'redispatch_key', v->>'redispatch_key');
      end if;
    end if;
  end loop;
  return v_out;
end $$;
revoke all on function public.email_redispatch_released_sweep(int) from public, anon, authenticated;
grant execute on function public.email_redispatch_released_sweep(int) to service_role;

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
  c        record;
  v_sha    text;
  v_out    jsonb;
  v_pre    record;
  v_key    text;
  v_marked boolean := false;
begin
  if p_tenant_id is null or p_id is null or p_actor_user_id is null or p_rail not in ('channel_actions', 'decisions') then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into v_pre from public._email_card(p_tenant_id, p_rail, p_id, false);
  if not coalesce(v_pre.o_found, false) then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  v_key := public._email_test_list_key(v_pre.o_class, v_pre.o_body);
  v_marked := public._email_test_list_marked(p_tenant_id, v_key);
  select * into c from public._email_card(p_tenant_id, p_rail, p_id, true);
  if not c.o_found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if public._email_test_list_key(c.o_class, c.o_body) is distinct from v_key then
    return jsonb_build_object('ok', false, 'code', 'card_changed');
  end if;
  if public._email_card_versions(c.o_body) = 0 then
    return jsonb_build_object('ok', false, 'code', 'redraft_required');
  end if;
  if v_marked then
    return jsonb_build_object('ok', false, 'code', 'test_list');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id
                    and role in ('owner', 'admin')) then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  if p_variant is null or p_variant < 1 or p_variant > public._email_card_versions(c.o_body) then
    return jsonb_build_object('ok', false, 'code', 'bad_variant');
  end if;
  if c.o_open and c.o_body ? 'planned_send_id' and not exists (
       select 1 from email_planned_sends s
        where s.tenant_id = p_tenant_id and s.card_rail = p_rail and s.card_id = p_id
          and s.id::text = c.o_body->>'planned_send_id'
          and s.content_version::text = c.o_body->>'plan_version'
          and s.status in ('ready', 'scheduled', 'skipped', 'blocked')) then
    return jsonb_build_object('ok', false, 'code', 'plan_changed');
  end if;
  if not c.o_open then
    if not c.o_approved then
      return jsonb_build_object('ok', false, 'code', 'not_open', 'status', c.o_status);
    end if;
    if p_rail = 'channel_actions' then
      return public._email_card_retry(p_tenant_id, p_id, p_actor_user_id, p_event_key, p_approved_count, p_variant);
    end if;
    if (c.o_body->>'chosen_variant')::int is distinct from p_variant then
      return jsonb_build_object('ok', false, 'code', 'not_open', 'status', c.o_status);
    end if;
    if c.o_status in ('approved', 'dispatching') then
      select case when d.dispatch_error like 'email_redispatch:r%'
                  then substring(d.dispatch_error from length('email_redispatch:') + 1) end
        into v_key from decisions d where d.id = p_id and d.tenant_id = p_tenant_id;
      return jsonb_strip_nulls(jsonb_build_object('ok', true, 'changed', false, 'status', c.o_status,
                                                 'class', c.o_class, 'redispatch_key', v_key));
    end if;
    if c.o_status = 'proposed' then
      return public._email_redispatch_released(p_tenant_id, p_id) || jsonb_build_object('class', c.o_class);
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

create or replace function public._email_hold_state(p_tenant_id uuid, p_rail text, p_id uuid)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case p_rail
    when 'channel_actions' then coalesce((
      select case
        when (ca.exec_result->>'audience_mismatch')::boolean is true then 'mail_left'
        when ca.exec_status = 'failed'
             and (ca.exec_result->>'code' is distinct from 'exec_outcome_unknown'
                  or (ca.exec_result->>'reconciled')::boolean is true
                  or coalesce(ca.exec_claimed_at < now() - interval '2 hours', true)) then 'unresolved'
        when ca.exec_status = 'dispatching' and ca.exec_claimed_at < now() - interval '2 hours' then 'unresolved'
        else 'settling' end
        from channel_actions ca where ca.id = p_id and ca.tenant_id = p_tenant_id), 'unresolved')
    when 'decisions' then coalesce((
      select case
        when exists (select 1 from email_bulk_sends b where b.decision_id = d.id and b.tenant_id = d.tenant_id
                       and b.total is distinct from 0) then 'zavi_sending'
        when d.status in ('dispatch_failed', 'rejected') then 'unresolved'
        when d.status = 'proposed' and d.approved_by is null then 'unresolved'
        when d.status = 'proposed' and coalesce(d.dispatched_at < now() - interval '2 hours', false) then 'unresolved'
        when d.status = 'dispatching' and d.dispatched_at < now() - interval '2 hours' then 'unresolved'
        else 'settling' end
        from decisions d where d.id = p_id and d.tenant_id = p_tenant_id), 'unresolved')
    else 'settling' end;
$$;
revoke all on function public._email_hold_state(uuid, text, uuid) from public, anon, authenticated;

commit;
