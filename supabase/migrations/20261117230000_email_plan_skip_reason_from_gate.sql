begin;

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
      v_skip := case when coalesce(p_unattended->'reasons', '[]'::jsonb) ? 'audience_over_limit' then 'audience_over_limit' else 'not_approved_in_time' end;
    elsif public._email_member_edit_untested(p_tenant_id, v_row.card_rail, v_row.card_id) then
      v_skip := 'member_edit_untested';
    else
      v_count := (p_unattended->>'count')::int;
      select tu.user_id into v_owner from tenant_users tu
       where tu.tenant_id = p_tenant_id and tu.role = 'owner' order by tu.user_id limit 1;
      select * into c from public._email_card(p_tenant_id, v_row.card_rail, v_row.card_id, true);
      if v_count is null then
        v_skip := 'not_approved_in_time';
      elsif v_count < 1 then
        v_skip := 'audience_empty';
      elsif v_count > 1000 then
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

commit;
