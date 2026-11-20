begin;

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
       order by md5(p_decision_id::text || ':' || c.email_norm), c.email_norm
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

commit;
