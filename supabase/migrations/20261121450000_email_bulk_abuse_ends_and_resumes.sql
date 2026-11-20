begin;

alter table public.email_bulk_sends
  add column if not exists abuse_complaints_base int not null default 0,
  add column if not exists abuse_bounces_base int not null default 0;

create or replace function public.email_bulk_settle_send(
  p_tenant_id   uuid,
  p_send_id     uuid,
  p_status      text,
  p_hold_reason text,
  p_next_run_at timestamptz
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v public.email_bulk_sends%rowtype;
  v_pending int; v_sending int; v_sent int; v_skipped int; v_failed int; v_unknown int;
  v_nobody_left boolean;
begin
  if p_tenant_id is null or p_send_id is null
     or (p_status is not null and p_status not in ('sending', 'waiting_for_tomorrow', 'held', 'done', 'failed')) then
    raise exception 'email_bulk_settle_send: invalid argument' using errcode = '22023';
  end if;
  select count(*) filter (where r.status = 'pending'),
         count(*) filter (where r.status = 'sending'),
         count(*) filter (where r.status = 'sent'),
         count(*) filter (where r.status = 'skipped'),
         count(*) filter (where r.status = 'failed'),
         count(*) filter (where r.status = 'unknown')
    into v_pending, v_sending, v_sent, v_skipped, v_failed, v_unknown
    from public.email_bulk_send_recipients r
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id;
  v_nobody_left := v_pending = 0 and v_sending = 0;

  if p_status = 'held' and p_hold_reason in ('abuse_complaints', 'abuse_bounces') then
    insert into public.email_bulk_abuse_holds (tenant_id, send_id, reason)
    values (p_tenant_id, p_send_id, p_hold_reason)
    on conflict (tenant_id) do update
      set send_id = excluded.send_id, reason = excluded.reason, created_at = now(),
          cleared_at = null, cleared_by = null
      where public.email_bulk_abuse_holds.cleared_at is not null;
  end if;

  update public.email_bulk_sends s
     set sent = v_sent, skipped = v_skipped, failed = v_failed, unknown = v_unknown,
         status = case
           when s.status in ('done', 'failed') then s.status
           when v_nobody_left and (
                  (p_status = 'held' and p_hold_reason in ('abuse_complaints', 'abuse_bounces'))
                  or (s.status = 'held' and s.hold_reason in ('abuse_complaints', 'abuse_bounces'))) then 'done'
           when p_status is null then s.status
           when s.status = 'held' then s.status
           else p_status end,
         hold_reason = case
           when s.status not in ('done', 'failed') and v_nobody_left and (
                  (p_status = 'held' and p_hold_reason in ('abuse_complaints', 'abuse_bounces'))
                  or (s.status = 'held' and s.hold_reason in ('abuse_complaints', 'abuse_bounces'))) then null
           when p_status = 'held' and s.status not in ('done', 'failed', 'held') then p_hold_reason
           else s.hold_reason end,
         next_run_at = case
           when p_status = 'waiting_for_tomorrow' and s.status not in ('done', 'failed', 'held') then p_next_run_at
           when p_status is null then s.next_run_at
           else null end,
         finished_at = case
           when s.status not in ('done', 'failed') and v_nobody_left and (
                  (p_status = 'held' and p_hold_reason in ('abuse_complaints', 'abuse_bounces'))
                  or (s.status = 'held' and s.hold_reason in ('abuse_complaints', 'abuse_bounces'))) then now()
           when p_status in ('done', 'failed') and s.status not in ('done', 'failed', 'held') then now()
           else s.finished_at end
   where s.id = p_send_id and s.tenant_id = p_tenant_id
  returning * into v;
  if v.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  return jsonb_build_object(
    'ok', true, 'status', v.status, 'hold_reason', v.hold_reason, 'next_run_at', v.next_run_at,
    'total', v.total, 'sent', v_sent, 'skipped', v_skipped, 'failed', v_failed,
    'unknown', v_unknown, 'pending', v_pending, 'sending', v_sending,
    'complaints', v.complaints - v.abuse_complaints_base, 'hard_bounces', v.hard_bounces - v.abuse_bounces_base);
end $$;
revoke all on function public.email_bulk_settle_send(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.email_bulk_settle_send(uuid, uuid, text, text, timestamptz) to service_role;

create or replace function public.email_bulk_record_feedback(
  p_tenant_id uuid,
  p_send_id   uuid,
  p_email     text,
  p_kind      text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  c_complaints_any constant int := 5;
  c_min_sent       constant int := 200;
  c_complaint_rate constant numeric := 0.003;
  c_bounce_rate    constant numeric := 0.05;
  v public.email_bulk_sends%rowtype;
  v_n int; v_sent int; v_tripped boolean := false; v_reason text;
  v_complaints int; v_bounces int;
begin
  if p_tenant_id is null or p_send_id is null or p_email is null
     or p_kind not in ('complaint', 'hard_bounce') then
    raise exception 'email_bulk_record_feedback: invalid argument' using errcode = '22023';
  end if;
  select * into v from public.email_bulk_sends s
   where s.id = p_send_id and s.tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  update public.email_bulk_send_recipients r
     set feedback = p_kind
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id
     and r.email_at_send = lower(trim(p_email)) and r.feedback is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', true, 'counted', false, 'tripped', false, 'reason', null,
                              'complaints', v.complaints, 'hard_bounces', v.hard_bounces);
  end if;
  if v_n > 0 then
    update public.email_bulk_sends s
       set complaints = s.complaints + (case when p_kind = 'complaint' then 1 else 0 end),
           hard_bounces = s.hard_bounces + (case when p_kind = 'hard_bounce' then 1 else 0 end)
     where s.id = p_send_id and s.tenant_id = p_tenant_id
    returning * into v;
  end if;

  select count(*) into v_sent from public.email_bulk_send_recipients r
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.status = 'sent';
  v_complaints := v.complaints - v.abuse_complaints_base;
  v_bounces := v.hard_bounces - v.abuse_bounces_base;
  if v_complaints >= c_complaints_any then
    v_tripped := true; v_reason := 'abuse_complaints';
  elsif v_sent >= c_min_sent then
    if v_complaints::numeric / v_sent >= c_complaint_rate then
      v_tripped := true; v_reason := 'abuse_complaints';
    elsif v_bounces::numeric / v_sent >= c_bounce_rate then
      v_tripped := true; v_reason := 'abuse_bounces';
    end if;
  end if;
  if v_tripped then
    update public.email_bulk_sends s
       set status = 'held', hold_reason = v_reason, next_run_at = null
     where s.id = p_send_id and s.tenant_id = p_tenant_id
       and s.status in ('sending', 'waiting_for_tomorrow')
       and exists (select 1 from public.email_bulk_send_recipients r
                    where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.status in ('pending', 'sending'));
    insert into public.email_bulk_abuse_holds (tenant_id, send_id, reason)
    values (p_tenant_id, p_send_id, v_reason)
    on conflict (tenant_id) do update
      set send_id = excluded.send_id, reason = excluded.reason, created_at = now(),
          cleared_at = null, cleared_by = null
      where public.email_bulk_abuse_holds.cleared_at is not null;
  end if;
  return jsonb_build_object('ok', true, 'counted', v_n > 0, 'tripped', v_tripped, 'reason', v_reason,
                            'complaints', v.complaints, 'hard_bounces', v.hard_bounces, 'sent', v_sent);
end $$;
revoke all on function public.email_bulk_record_feedback(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.email_bulk_record_feedback(uuid, uuid, text, text) to service_role;

create or replace function public.email_bulk_resume_send(
  p_tenant_id uuid,
  p_send_id   uuid
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v public.email_bulk_sends%rowtype;
  v_pending int;
  v_flag jsonb;
  v_setting jsonb;
  v_blob jsonb;
  v_domain text;
begin
  if p_tenant_id is null or p_send_id is null then
    raise exception 'email_bulk_resume_send: null argument' using errcode = '22023';
  end if;
  select * into v from public.email_bulk_sends s
   where s.id = p_send_id and s.tenant_id = p_tenant_id
   for update;
  if v.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v.status <> 'held' then
    return jsonb_build_object('ok', false, 'reason', 'not_held');
  end if;
  if coalesce(v.hold_reason, '') not in ('abuse_complaints', 'abuse_bounces', 'provider_refused', 'bulk_check_failed') then
    return jsonb_build_object('ok', false, 'reason', 'not_resumable', 'hold_reason', v.hold_reason);
  end if;
  if exists (select 1 from public.email_bulk_abuse_holds a
              where a.tenant_id = p_tenant_id and a.cleared_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'abuse_hold');
  end if;
  select t.value into v_flag from public.tenant_app_setting t
   where t.tenant_id = p_tenant_id and t.key = 'bulk_outbound_enabled';
  if v_flag = 'false'::jsonb then
    return jsonb_build_object('ok', false, 'reason', 'bulk_outbound_disabled');
  end if;
  select s.value into v_setting from public.app_setting s where s.key = 'bulk_email_send_enabled';
  select c.blob into v_blob from public.system_config c where c.id = 1;
  if not public._bulk_send_flag_running(v_setting)
     or not public._bulk_send_flag_running(v_blob -> 'bulk_email_send_enabled') then
    return jsonb_build_object('ok', false, 'reason', 'bulk_sending_paused');
  end if;
  v_domain := nullif(lower(split_part(v.from_address, '@', 2)), '');
  if not exists (select 1 from public.tenant_sending_domain d
                  where d.tenant_id = p_tenant_id and d.verification_status = 'verified'
                    and d.provider_domain_id is not null
                    and lower(d.domain) = v_domain) then
    return jsonb_build_object('ok', false, 'reason', 'sending_domain_not_verified');
  end if;
  if not exists (select 1 from public.email_lists l
                  where l.id = v.list_id and l.tenant_id = p_tenant_id and l.archived_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'list_archived');
  end if;
  if not exists (select 1 from public.email_list_versions lv
                  where lv.id = v.list_version_id and lv.list_id = v.list_id and lv.tenant_id = p_tenant_id
                    and lv.consent_confirmed_at is not null) then
    return jsonb_build_object('ok', false, 'reason', 'list_not_consented');
  end if;
  select count(*) into v_pending from public.email_bulk_send_recipients r
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.status = 'pending';
  if v_pending = 0 then
    return jsonb_build_object('ok', false, 'reason', 'nobody_waiting');
  end if;
  update public.email_bulk_sends s
     set status = 'sending', hold_reason = null, next_run_at = null,
         abuse_complaints_base = case when v.hold_reason in ('abuse_complaints', 'abuse_bounces') then v.complaints else s.abuse_complaints_base end,
         abuse_bounces_base = case when v.hold_reason in ('abuse_complaints', 'abuse_bounces') then v.hard_bounces else s.abuse_bounces_base end
   where s.id = p_send_id and s.tenant_id = p_tenant_id;
  return jsonb_build_object('ok', true, 'pending', v_pending);
end $$;
revoke all on function public.email_bulk_resume_send(uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_bulk_resume_send(uuid, uuid) to service_role;

commit;
