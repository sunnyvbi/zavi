begin;

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
  if v_key is not null and exists (
       select 1 from email_send_reservations r
        where r.tenant_id = p_tenant_id and r.list_key = v_key and r.state = 'held'
          and not (r.card_rail = p_rail and r.card_id = p_id)) then
    return jsonb_build_object('ok', false, 'code', 'list_send_in_flight');
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
  if exists (select 1 from email_planned_sends s
              where s.tenant_id = p_tenant_id and s.card_rail = p_rail and s.card_id = p_id and s.status = 'scheduled') then
    return jsonb_build_object('ok', false, 'code', 'scheduled_send_pending');
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

create or replace function public.email_list_version_freeze_count(p_tenant_id uuid, p_version_id uuid) returns int
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return (select count(*)::int
            from public.email_list_version_contacts m
            join public.email_contacts c on c.tenant_id = m.tenant_id and c.id = m.contact_id
           where m.tenant_id = p_tenant_id and m.version_id = p_version_id
             and c.erased_at is null and c.email_norm is not null
             and public.email_bulk_block_reason(p_tenant_id, c.email_norm) is null);
end $$;
revoke all on function public.email_list_version_freeze_count(uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_list_version_freeze_count(uuid, uuid) to service_role;

create or replace function public.email_bulk_freeze_send(
  p_tenant_id    uuid,
  p_decision_id  uuid,
  p_list_id      uuid,
  p_version_id   uuid,
  p_subject      text,
  p_body_text    text,
  p_from_address text,
  p_reply_to     text,
  p_cap          int,
  p_body_html    text default null,
  p_render_sha   text default null
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_send  public.email_bulk_sends%rowtype;
  v_total int;
  v_cap   int := least(coalesce(p_cap, 0), 1000);
begin
  if p_tenant_id is null or p_decision_id is null or p_list_id is null or p_version_id is null
     or p_subject is null or p_body_text is null or p_from_address is null
     or p_cap is null or p_cap < 1
     or ((p_body_html is null) <> (p_render_sha is null)) then
    raise exception 'email_bulk_freeze_send: invalid argument' using errcode = '22023';
  end if;

  select * into v_send from public.email_bulk_sends s
   where s.decision_id = p_decision_id and s.tenant_id = p_tenant_id;
  if found then
    return jsonb_build_object('ok', true, 'created', false, 'send_id', v_send.id,
                              'total', v_send.total, 'status', v_send.status);
  end if;

  if exists (select 1 from public.email_bulk_abuse_holds a
              where a.tenant_id = p_tenant_id and a.cleared_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'abuse_hold');
  end if;
  if not exists (select 1 from public.decisions d
                  where d.id = p_decision_id and d.tenant_id = p_tenant_id
                    and d.decision_class = 'bulk_outbound.send'
                    and d.approved_by is not null
                    and d.status in ('approved', 'dispatching')) then
    return jsonb_build_object('ok', false, 'reason', 'not_approved');
  end if;
  if not exists (select 1 from public.email_lists l
                  where l.id = p_list_id and l.tenant_id = p_tenant_id and l.archived_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'list_archived');
  end if;
  if not exists (select 1 from public.email_list_versions v
                  where v.id = p_version_id and v.list_id = p_list_id and v.tenant_id = p_tenant_id
                    and v.consent_confirmed_at is not null) then
    return jsonb_build_object('ok', false, 'reason', 'version_not_consented');
  end if;
  if exists (select 1 from public.decisions d
              where d.id = p_decision_id and d.tenant_id = p_tenant_id and d.approved_by_source = 'plan_autopilot') then
    perform 1 from public.email_lists l where l.id = p_list_id and l.tenant_id = p_tenant_id for update;
    if not exists (select 1 from public.email_lists l
                    where l.id = p_list_id and l.tenant_id = p_tenant_id and l.active_version_id = p_version_id) then
      return jsonb_build_object('ok', false, 'reason', 'list_version_changed');
    end if;
    if public.email_list_version_freeze_count(p_tenant_id, p_version_id) > 1000 then
      return jsonb_build_object('ok', false, 'reason', 'audience_over_limit');
    end if;
  end if;

  insert into public.email_bulk_sends
    (tenant_id, decision_id, list_id, list_version_id, subject, body_text, body_html, render_sha, from_address, reply_to)
  values
    (p_tenant_id, p_decision_id, p_list_id, p_version_id, p_subject, p_body_text, p_body_html, p_render_sha, p_from_address, p_reply_to)
  on conflict (decision_id) do nothing
  returning * into v_send;
  if v_send.id is null then
    select * into v_send from public.email_bulk_sends s
     where s.decision_id = p_decision_id and s.tenant_id = p_tenant_id;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'not_approved');
    end if;
    return jsonb_build_object('ok', true, 'created', false, 'send_id', v_send.id,
                              'total', v_send.total, 'status', v_send.status);
  end if;

  insert into public.email_bulk_send_recipients (send_id, tenant_id, contact_id, email_at_send)
  select v_send.id, p_tenant_id, x.id, x.email_norm
    from (
      select c.id, c.email_norm
        from public.email_list_version_contacts m
        join public.email_contacts c on c.tenant_id = m.tenant_id and c.id = m.contact_id
       where m.tenant_id = p_tenant_id and m.version_id = p_version_id
         and c.erased_at is null and c.email_norm is not null
         and public.email_bulk_block_reason(p_tenant_id, c.email_norm) is null
       order by c.email_norm
       limit v_cap
    ) x;
  get diagnostics v_total = row_count;
  update public.email_bulk_sends s set total = v_total
   where s.id = v_send.id and s.tenant_id = p_tenant_id;

  return jsonb_build_object('ok', true, 'created', true, 'send_id', v_send.id,
                            'total', v_total, 'status', 'sending');
end $$;
revoke all on function public.email_bulk_freeze_send(uuid, uuid, uuid, uuid, text, text, text, text, int, text, text) from public, anon, authenticated;
grant execute on function public.email_bulk_freeze_send(uuid, uuid, uuid, uuid, text, text, text, text, int, text, text) to service_role;

create or replace function public.email_bulk_close_held_send(p_tenant_id uuid, p_send_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  update email_bulk_sends s
     set status = 'failed', finished_at = coalesce(s.finished_at, now()), next_run_at = null
   where s.id = p_send_id and s.tenant_id = p_tenant_id and s.status = 'held'
     and not exists (select 1 from email_bulk_send_recipients r
                      where r.send_id = s.id and r.tenant_id = s.tenant_id and r.status in ('sent', 'unknown', 'sending'));
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform public._email_reservation_settle('decisions',
      (select decision_id from email_bulk_sends where id = p_send_id and tenant_id = p_tenant_id),
      'released', 'provider_refused');
  end if;
  return v_n > 0;
end $$;
revoke all on function public.email_bulk_close_held_send(uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_bulk_close_held_send(uuid, uuid) to service_role;

create or replace function public.email_redispatch_enqueue_failed(p_tenant_id uuid, p_decision_id uuid, p_redispatch_key text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  perform set_config('zavi.email_card_approve', 'on', true);
  update decisions d set status = 'proposed'
   where d.id = p_decision_id and d.tenant_id = p_tenant_id and d.status = 'approved'
     and p_redispatch_key = 'r' || floor(extract(epoch from coalesce(d.dispatched_at, d.approved_at, now())) * 1000)::bigint::text;
  perform set_config('zavi.email_card_approve', '', true);
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;
revoke all on function public.email_redispatch_enqueue_failed(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.email_redispatch_enqueue_failed(uuid, uuid, text) to service_role;

create or replace function public.email_bulk_refire_enqueue_failed(p_tenant_id uuid, p_send_id uuid, p_attempt int) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  update email_bulk_sends
     set fanout_recoveries = greatest(0, fanout_recoveries - 1),
         fanout_recovered_at = now() - interval '46 minutes'
   where id = p_send_id and tenant_id = p_tenant_id and status = 'sending'
     and fanout_recoveries = p_attempt;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;
revoke all on function public.email_bulk_refire_enqueue_failed(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.email_bulk_refire_enqueue_failed(uuid, uuid, int) to service_role;

commit;
