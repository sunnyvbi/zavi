
begin;

create or replace function public._bulk_send_flag_running(p_value jsonb)
returns boolean
language sql immutable
set search_path = public, pg_temp as $$
  select p_value is null
      or jsonb_typeof(p_value) = 'null'
      or p_value = 'true'::jsonb
      or (jsonb_typeof(p_value) = 'string' and lower(btrim(p_value #>> '{}')) = 'true')
$$;
revoke all on function public._bulk_send_flag_running(jsonb) from public, anon, authenticated;
grant execute on function public._bulk_send_flag_running(jsonb) to service_role;

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
     set status = 'sending', hold_reason = null, next_run_at = null
   where s.id = p_send_id and s.tenant_id = p_tenant_id;
  return jsonb_build_object('ok', true, 'pending', v_pending);
end $$;
revoke all on function public.email_bulk_resume_send(uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_bulk_resume_send(uuid, uuid) to service_role;

commit;
