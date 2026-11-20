begin;

create or replace function public.email_bulk_stop_send(p_tenant_id uuid, p_actor_user_id uuid, p_decision_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v       email_bulk_sends%rowtype;
  v_n     int;
  v_sent  int;
begin
  if p_tenant_id is null or p_actor_user_id is null or p_decision_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id
                    and role in ('owner', 'admin')) then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  select * into v from email_bulk_sends s where s.decision_id = p_decision_id and s.tenant_id = p_tenant_id for update;
  if v.id is null or v.status not in ('sending', 'waiting_for_tomorrow', 'held') then
    return jsonb_build_object('ok', false, 'code', 'not_stoppable', 'status', v.status);
  end if;
  update email_bulk_send_recipients r
     set status = 'skipped', skip_reason = 'stopped', stamped_at = now()
   where r.send_id = v.id and r.tenant_id = p_tenant_id and r.status = 'pending';
  get diagnostics v_n = row_count;
  update email_bulk_sends s set status = 'held', hold_reason = 'stopped', next_run_at = null
   where s.id = v.id;
  select count(*) into v_sent from email_bulk_send_recipients r
   where r.send_id = v.id and r.tenant_id = p_tenant_id and r.status = 'sent';
  update email_bulk_sends s set sent = v_sent,
         skipped = (select count(*) from email_bulk_send_recipients r where r.send_id = v.id and r.tenant_id = p_tenant_id and r.status = 'skipped')
   where s.id = v.id;
  return jsonb_build_object('ok', true, 'stopped', v_n, 'already_sent', v_sent,
                            'send_id', v.id, 'was', v.status, 'was_reason', v.hold_reason);
end $$;
revoke all on function public.email_bulk_stop_send(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_bulk_stop_send(uuid, uuid, uuid) to service_role;

commit;
