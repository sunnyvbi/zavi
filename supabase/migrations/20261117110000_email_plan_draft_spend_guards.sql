begin;

create or replace function public.move_email_planned_send(
  p_tenant_id uuid, p_actor uuid, p_id uuid, p_planned_at timestamptz, p_expected_gen int, p_tz text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  l record;
  v_row email_planned_sends%rowtype;
  v_week int;
  v_near timestamptz;
  v_draft_due timestamptz;
begin
  if p_actor is null or p_planned_at is null then return jsonb_build_object('ok', false, 'code', 'bad_request'); end if;
  if p_tz is null or not exists (select 1 from pg_timezone_names where name = p_tz) then
    return jsonb_build_object('ok', false, 'code', 'bad_timezone');
  end if;
  select * into l from public._email_plan_lock_item(p_tenant_id, p_id, p_actor);
  if l.o_code is not null then return jsonb_build_object('ok', false, 'code', l.o_code); end if;
  v_row := l.o_row;
  if v_row.schedule_gen is distinct from p_expected_gen then
    return jsonb_build_object('ok', false, 'code', 'plan_changed');
  end if;
  if v_row.status not in ('planned', 'drafting', 'ready', 'scheduled') then
    return jsonb_build_object('ok', false, 'code', 'not_movable', 'status', v_row.status);
  end if;
  if v_row.planned_at <= now() then return jsonb_build_object('ok', false, 'code', 'not_movable'); end if;
  if p_planned_at < now() + interval '1 hour' then return jsonb_build_object('ok', false, 'code', 'too_soon'); end if;
  if p_planned_at > now() + interval '14 days' then return jsonb_build_object('ok', false, 'code', 'too_far'); end if;
  perform pg_advisory_xact_lock(hashtextextended('email_plan:' || p_tenant_id::text, 0));
  select count(*) into v_week from email_planned_sends
   where tenant_id = p_tenant_id and id <> p_id
     and public._email_plan_week(planned_at, planned_tz) = public._email_plan_week(p_planned_at, p_tz);
  if v_week >= 3 then return jsonb_build_object('ok', false, 'code', 'week_full'); end if;
  if exists (select 1 from email_planned_sends
              where tenant_id = p_tenant_id and id <> p_id and list_key = v_row.list_key and status not in ('skipped', 'blocked')
                and planned_at > p_planned_at - interval '7 days' and planned_at < p_planned_at + interval '7 days') then
    return jsonb_build_object('ok', false, 'code', 'list_spacing');
  end if;
  v_near := public._email_list_sent_near(p_tenant_id, v_row.list_key, p_planned_at, v_row.card_rail, v_row.card_id);
  if v_near is not null then
    return jsonb_build_object('ok', false, 'code', 'list_sent_recently', 'last_send_at', v_near);
  end if;
  update email_planned_sends set planned_at = p_planned_at, planned_tz = p_tz, schedule_gen = schedule_gen + 1, updated_at = now()
   where id = p_id returning * into v_row;
  perform public._email_plan_job(p_tenant_id, p_id, 'deadline', 'deadline:' || p_id || ':g' || v_row.schedule_gen, p_planned_at);
  if v_row.card_id is null then
    v_draft_due := greatest(now(), p_planned_at - interval '24 hours');
    if v_row.status = 'drafting' then
      v_draft_due := greatest(v_draft_due, least(
        coalesce((select max(j.due_at) from email_plan_jobs j
                   where j.tenant_id = p_tenant_id and j.item_id = p_id and j.kind = 'draft' and j.state = 'pending'),
                 now() + interval '45 minutes'),
        p_planned_at - interval '20 minutes'));
    end if;
    perform public._email_plan_job(p_tenant_id, p_id, 'draft', 'draft:' || p_id || ':v' || v_row.content_version || ':g' || v_row.schedule_gen,
                                   v_draft_due);
  end if;
  return jsonb_build_object('ok', true, 'schedule_gen', v_row.schedule_gen, 'planned_at', v_row.planned_at);
end $$;
revoke all on function public.move_email_planned_send(uuid, uuid, uuid, timestamptz, int, text) from public, anon, authenticated;
grant execute on function public.move_email_planned_send(uuid, uuid, uuid, timestamptz, int, text) to service_role;

create or replace function public.begin_email_plan_draft(p_tenant_id uuid, p_id uuid, p_job_id uuid, p_lease_token uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row email_planned_sends%rowtype;
  v_key text;
begin
  select * into v_row from email_planned_sends where id = p_id and tenant_id = p_tenant_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  select j.job_key into v_key from email_plan_jobs j
   where j.id = p_job_id and j.tenant_id = p_tenant_id and j.item_id = p_id and j.kind = 'draft'
     and j.state = 'leased' and j.lease_token = p_lease_token
     for update;
  if v_key is not null
     and not exists (select 1 from email_plan_jobs j where j.id = p_job_id and j.lease_until > clock_timestamp()) then
    v_key := null;
  end if;
  if v_key is null
     or not (v_key = 'draft:' || p_id || ':v' || v_row.content_version || ':g' || v_row.schedule_gen
             or v_key like 'draft:' || p_id || ':v' || v_row.content_version || ':g' || v_row.schedule_gen || ':%') then
    return jsonb_build_object('ok', true, 'attempt', null, 'status', v_row.status, 'reason', 'superseded');
  end if;
  if v_row.status not in ('planned', 'drafting') or v_row.card_id is not null then
    return jsonb_build_object('ok', true, 'attempt', null, 'status', v_row.status);
  end if;
  if v_row.vetoed_at is not null then
    return jsonb_build_object('ok', true, 'attempt', null, 'status', v_row.status, 'reason', 'vetoed');
  end if;
  if v_row.route = 'zavi_list' and not exists (
       select 1 from email_lists l
        where l.tenant_id = p_tenant_id and l.id::text = lower(trim(v_row.list_id)) and l.archived_at is null) then
    update email_planned_sends set status = 'skipped', status_reason = 'list_archived', updated_at = now() where id = p_id;
    update email_plan_jobs set state = 'done', lease_token = null, lease_until = null, last_error = 'list_archived'
     where tenant_id = p_tenant_id and item_id = p_id and state = 'pending';
    return jsonb_build_object('ok', true, 'attempt', null, 'status', 'skipped', 'reason', 'list_archived');
  end if;
  if public.email_send_paused(p_tenant_id) then
    if v_row.planned_at < now() + interval '15 minutes' then
      update email_planned_sends set status = 'skipped', status_reason = 'paused', updated_at = now() where id = p_id;
      update email_plan_jobs set state = 'done', lease_token = null, lease_until = null, last_error = 'paused'
       where tenant_id = p_tenant_id and item_id = p_id and kind = 'draft' and state = 'pending';
      return jsonb_build_object('ok', true, 'attempt', null, 'status', 'skipped', 'reason', 'paused_too_late');
    end if;
    return jsonb_build_object('ok', true, 'attempt', null, 'status', v_row.status, 'reason', 'paused');
  end if;
  if v_row.draft_attempts >= 3 or v_row.planned_at < now() + interval '15 minutes' then
    update email_planned_sends set status = 'skipped', status_reason = 'no_draft', updated_at = now() where id = p_id;
    update email_plan_jobs set state = 'done', lease_token = null, lease_until = null, last_error = 'out_of_attempts'
     where tenant_id = p_tenant_id and item_id = p_id and kind = 'draft' and state = 'pending';
    return jsonb_build_object('ok', true, 'attempt', null, 'status', 'skipped', 'reason', 'out_of_attempts');
  end if;
  update email_planned_sends set status = 'drafting', draft_attempts = draft_attempts + 1, updated_at = now()
   where id = p_id returning * into v_row;
  return jsonb_build_object('ok', true, 'attempt', v_row.draft_attempts, 'version', v_row.content_version,
    'route', v_row.route, 'list_id', v_row.list_id, 'list_name', v_row.list_name, 'planned_at', v_row.planned_at,
    'planned_tz', v_row.planned_tz, 'angle', v_row.angle, 'why', v_row.why, 'source', v_row.source);
end $$;
revoke all on function public.begin_email_plan_draft(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.begin_email_plan_draft(uuid, uuid, uuid, uuid) to service_role;

commit;
