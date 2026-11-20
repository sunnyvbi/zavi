begin;

create or replace function public.rebind_email_planned_card(
  p_tenant_id uuid, p_id uuid, p_version int, p_old_rail text, p_old_id uuid, p_new_rail text, p_new_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key text;
  v_row email_planned_sends%rowtype;
  o     record;
  n     record;
  v_out jsonb;
begin
  if p_old_rail not in ('channel_actions', 'decisions') or p_new_rail not in ('channel_actions', 'decisions')
     or p_old_id is null or p_new_id is null or p_old_id = p_new_id then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  select list_key into v_key from email_planned_sends where id = p_id and tenant_id = p_tenant_id;
  if v_key is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  perform public._email_list_lock(p_tenant_id, v_key);
  select * into v_row from email_planned_sends where id = p_id and tenant_id = p_tenant_id for update;
  if v_row.card_rail is not distinct from p_new_rail and v_row.card_id is not distinct from p_new_id
     and v_row.content_version = p_version then
    return jsonb_build_object('ok', true, 'replayed', true);
  end if;
  if v_row.content_version is distinct from p_version
     or v_row.card_rail is distinct from p_old_rail or v_row.card_id is distinct from p_old_id
     or v_row.status not in ('ready', 'skipped', 'blocked') then
    return jsonb_build_object('ok', false, 'code', 'plan_changed');
  end if;
  select * into o from public._email_card(p_tenant_id, p_old_rail, p_old_id, true);
  if not coalesce(o.o_found, false) or not o.o_open then
    return jsonb_build_object('ok', false, 'code', 'plan_changed');
  end if;
  select * into n from public._email_card(p_tenant_id, p_new_rail, p_new_id, false);
  if not coalesce(n.o_found, false) or not n.o_open then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if public._email_test_list_key(n.o_class, n.o_body) is distinct from v_key then
    return jsonb_build_object('ok', false, 'code', 'wrong_list');
  end if;
  if (n.o_body->>'planned_send_id') is distinct from p_id::text or (n.o_body->>'plan_version')::int is distinct from p_version then
    return jsonb_build_object('ok', false, 'code', 'not_this_plan');
  end if;
  update email_planned_sends set card_rail = p_new_rail, card_id = p_new_id, updated_at = now() where id = p_id;
  v_out := public.replace_email_card(p_tenant_id, p_old_rail, p_old_id, p_new_rail, p_new_id);
  if coalesce((v_out->>'replaced')::boolean, false) is not true then
    raise exception 'email_plan_rebind_failed';
  end if;
  return jsonb_build_object('ok', true);
exception when invalid_text_representation then
  return jsonb_build_object('ok', false, 'code', 'not_this_plan');
end $$;
revoke all on function public.rebind_email_planned_card(uuid, uuid, int, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.rebind_email_planned_card(uuid, uuid, int, text, uuid, text, uuid) to service_role;

create or replace function public.change_email_planned_angle(
  p_tenant_id uuid, p_actor uuid, p_id uuid, p_angle text, p_expected_version int
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  l record;
  v_row email_planned_sends%rowtype;
  v_angle text := nullif(trim(coalesce(p_angle, '')), '');
begin
  if p_actor is null or v_angle is null or length(v_angle) > 120 then return jsonb_build_object('ok', false, 'code', 'bad_request'); end if;
  select * into l from public._email_plan_lock_item(p_tenant_id, p_id, p_actor);
  if l.o_code is not null then return jsonb_build_object('ok', false, 'code', l.o_code); end if;
  v_row := l.o_row;
  if v_row.content_version is distinct from p_expected_version then return jsonb_build_object('ok', false, 'code', 'plan_changed'); end if;
  if v_row.status not in ('planned', 'drafting', 'ready', 'scheduled') or v_row.planned_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'not_changeable', 'status', v_row.status);
  end if;
  if v_row.planned_at < now() + interval '1 hour' then
    return jsonb_build_object('ok', false, 'code', 'angle_too_late');
  end if;
  if v_row.card_id is null then
    if exists (select 1 from email_plan_jobs j
                where j.tenant_id = p_tenant_id and j.item_id = p_id and j.kind = 'draft'
                  and j.state = 'leased' and j.lease_until > clock_timestamp())
       or exists (select 1 from agent_runs r
                   where r.tenant_id = p_tenant_id and r.channel_slug = 'email_marketing'
                     and r.status in ('queued', 'running')
                     and r.payload->'email_plan'->>'item_id' = p_id::text) then
      return jsonb_build_object('ok', false, 'code', 'draft_running');
    end if;
    if v_row.draft_attempts >= 3 then
      return jsonb_build_object('ok', false, 'code', 'draft_tries_used');
    end if;
  end if;
  update email_planned_sends
     set angle = v_angle, content_version = content_version + 1, schedule_gen = schedule_gen + 1, status = 'planned', status_reason = null,
         card_rail = null, card_id = null,
         draft_attempts = case when (l.o_row).card_id is null then draft_attempts else 0 end,
         vetoed_at = null, vetoed_by = null,
         sched_variant = null, sched_count = null, sched_by = null, sched_sha = null, sched_version = null,
         sched_card_id = null, sched_account = null, sched_at = null, updated_at = now()
   where id = p_id returning * into v_row;
  perform public._email_plan_reject_card(p_tenant_id, (l.o_row).card_rail, (l.o_row).card_id, 'plan_angle_changed');
  perform public._email_plan_job(p_tenant_id, p_id, 'draft', 'draft:' || p_id || ':v' || v_row.content_version || ':g' || v_row.schedule_gen,
                                 greatest(now(), v_row.planned_at - interval '24 hours'));
  perform public._email_plan_job(p_tenant_id, p_id, 'deadline', 'deadline:' || p_id || ':g' || v_row.schedule_gen, v_row.planned_at);
  return jsonb_build_object('ok', true, 'content_version', v_row.content_version, 'schedule_gen', v_row.schedule_gen);
end $$;
revoke all on function public.change_email_planned_angle(uuid, uuid, uuid, text, int) from public, anon, authenticated;
grant execute on function public.change_email_planned_angle(uuid, uuid, uuid, text, int) to service_role;

commit;
