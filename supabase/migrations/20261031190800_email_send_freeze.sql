
begin;

create or replace function public._email_card(p_tenant_id uuid, p_rail text, p_id uuid, p_lock boolean,
  out o_found boolean, out o_class text, out o_body jsonb, out o_open boolean, out o_status text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ca channel_actions%rowtype;
  v_d  decisions%rowtype;
begin
  o_found := false;
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
    o_open := v_ca.status in ('pending', 'snoozed') and v_ca.exec_status is null and v_ca.approved_by is null;
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
    o_open := v_d.status = 'proposed' and v_d.approved_by is null;
  end if;
end $$;
revoke all on function public._email_card(uuid, text, uuid, boolean) from public, anon, authenticated;

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
     or new.approved_by is distinct from old.approved_by
     or new.approved_by_source is distinct from old.approved_by_source
     or (old.approved_by is not null and new.body is distinct from old.body) then
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
     or new.approved_by is distinct from old.approved_by
     or new.approved_by_source is distinct from old.approved_by_source then
    raise exception 'email_card_approve_required: an email send is approved only from its email card'
      using errcode = '42501';
  end if;
  if new.exec_status is distinct from old.exec_status and not coalesce(
    (new.exec_status is null and old.approved_by is null and old.exec_status not in ('queued', 'dispatching', 'executed'))
    or new.exec_status = 'failed'
    or (new.exec_status = 'dispatching' and old.exec_status = 'queued')
    or (new.exec_status = 'queued' and old.exec_status = 'dispatching')
    or (new.exec_status = 'executed' and old.exec_status in ('dispatching', 'failed') and old.approved_by is not null),
    false
  ) then
    raise exception 'email_card_approve_required: an email send is approved only from its email card'
      using errcode = '42501';
  end if;
  if coalesce(old.exec_status in ('queued', 'dispatching', 'executed'), false) or old.approved_by is not null then
    if new.exec_payload is distinct from old.exec_payload then
      raise exception 'email_card_approve_required: an approved email is sent as approved'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

revoke all on function channel_actions_email_send_guard() from public, anon, authenticated;

commit;
