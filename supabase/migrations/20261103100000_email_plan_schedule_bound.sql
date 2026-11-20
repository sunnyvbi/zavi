
begin;

alter table public.email_planned_sends add column if not exists sched_request text;

create or replace function public.schedule_email_planned_send(
  p_tenant_id uuid, p_actor uuid, p_id uuid, p_variant int, p_count int,
  p_expected_gen int, p_expected_version int, p_request_key text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  l     record;
  c     record;
  v_sha text;
  v_req text := left(nullif(trim(coalesce(p_request_key, '')), ''), 200);
begin
  if p_actor is null or v_req is null or p_expected_gen is null or p_expected_version is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  select * into l from public._email_plan_lock_item(p_tenant_id, p_id, p_actor);
  if l.o_code is not null then return jsonb_build_object('ok', false, 'code', l.o_code); end if;
  if (l.o_row).sched_request is not distinct from v_req then
    return jsonb_build_object('ok', true, 'replayed', true, 'status', (l.o_row).status, 'planned_at', (l.o_row).planned_at);
  end if;
  if (l.o_row).schedule_gen is distinct from p_expected_gen or (l.o_row).content_version is distinct from p_expected_version then
    return jsonb_build_object('ok', false, 'code', 'plan_changed');
  end if;
  if (l.o_row).status not in ('ready', 'scheduled') or (l.o_row).card_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_ready', 'status', (l.o_row).status);
  end if;
  if (l.o_row).planned_at <= now() + interval '2 minutes' then
    return jsonb_build_object('ok', false, 'code', 'too_late');
  end if;
  if public._email_test_list_marked(p_tenant_id, (l.o_row).list_key) then
    return jsonb_build_object('ok', false, 'code', 'test_list');
  end if;
  select * into c from public._email_card(p_tenant_id, (l.o_row).card_rail, (l.o_row).card_id, true);
  if not coalesce(c.o_found, false) or not c.o_open then
    return jsonb_build_object('ok', false, 'code', 'not_open');
  end if;
  if public._email_card_versions(c.o_body) = 0 then return jsonb_build_object('ok', false, 'code', 'redraft_required'); end if;
  if p_variant is null or p_variant < 1 or p_variant > public._email_card_versions(c.o_body) then
    return jsonb_build_object('ok', false, 'code', 'bad_variant');
  end if;
  if p_count is null or p_count < 1 then return jsonb_build_object('ok', false, 'code', 'count_required'); end if;
  v_sha := public.email_card_test_sha(c.o_body, p_variant);
  if not exists (select 1 from email_test_sends t
                   join tenant_users tu on tu.tenant_id = t.tenant_id and tu.user_id = t.user_id
                  where t.tenant_id = p_tenant_id and t.rail = (l.o_row).card_rail and t.card_id = (l.o_row).card_id
                    and t.variant = p_variant and t.test_sha = v_sha and tu.role in ('owner', 'admin')) then
    return jsonb_build_object('ok', false, 'code', 'test_required');
  end if;
  update email_planned_sends
     set status = 'scheduled', status_reason = null, vetoed_at = null, vetoed_by = null,
         sched_variant = p_variant, sched_count = p_count, sched_by = p_actor, sched_sha = v_sha,
         sched_version = content_version, sched_card_id = card_id,
         sched_account = public._email_plan_account(c.o_class, c.o_body), sched_at = now(),
         sched_request = v_req, updated_at = now()
   where id = p_id;
  return jsonb_build_object('ok', true, 'replayed', false, 'planned_at', (l.o_row).planned_at);
end $$;
revoke all on function public.schedule_email_planned_send(uuid, uuid, uuid, int, int, int, int, text) from public, anon, authenticated;
grant execute on function public.schedule_email_planned_send(uuid, uuid, uuid, int, int, int, int, text) to service_role;

create or replace function public.schedule_email_planned_send(
  p_tenant_id uuid, p_actor uuid, p_id uuid, p_variant int, p_count int
) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', false, 'code', 'plan_changed');
$$;
revoke all on function public.schedule_email_planned_send(uuid, uuid, uuid, int, int) from public, anon, authenticated;

create or replace function public.withdraw_email_planned_send(p_tenant_id uuid, p_actor uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  l     record;
  v_row email_planned_sends%rowtype;
begin
  if p_actor is null then return jsonb_build_object('ok', false, 'code', 'bad_request'); end if;
  select * into l from public._email_plan_lock_item(p_tenant_id, p_id, p_actor);
  if l.o_code is not null then return jsonb_build_object('ok', false, 'code', l.o_code); end if;
  if (l.o_row).status not in ('ready', 'scheduled') then
    return jsonb_build_object('ok', false, 'code', 'not_withdrawable', 'status', (l.o_row).status);
  end if;
  update email_planned_sends
     set status = 'ready',
         vetoed_at = now(), vetoed_by = p_actor,
         sched_variant = null, sched_count = null, sched_by = null, sched_sha = null, sched_version = null,
         sched_card_id = null, sched_account = null, sched_at = null,
         schedule_gen = schedule_gen + 1, updated_at = now()
   where id = p_id
   returning * into v_row;
  perform public._email_plan_job(p_tenant_id, p_id, 'deadline', 'deadline:' || p_id || ':g' || v_row.schedule_gen, v_row.planned_at);
  return jsonb_build_object('ok', true, 'schedule_gen', v_row.schedule_gen);
end $$;
revoke all on function public.withdraw_email_planned_send(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.withdraw_email_planned_send(uuid, uuid, uuid) to service_role;

create or replace function public.email_planned_for_card(p_tenant_id uuid, p_rail text, p_card_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', s.id, 'planned_at', s.planned_at, 'timezone', s.planned_tz, 'status', s.status,
                            'status_reason', s.status_reason, 'schedule_gen', s.schedule_gen,
                            'content_version', s.content_version, 'vetoed', s.vetoed_at is not null,
                            'scheduled', case when s.sched_at is null then null
                              else jsonb_build_object('variant', s.sched_variant, 'count', s.sched_count, 'by', s.sched_by) end)
    from email_planned_sends s where s.tenant_id = p_tenant_id and s.card_rail = p_rail and s.card_id = p_card_id;
$$;
revoke all on function public.email_planned_for_card(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.email_planned_for_card(uuid, text, uuid) to service_role;

create or replace function public.email_planned_send_row(p_tenant_id uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', s.id, 'planned_at', s.planned_at, 'timezone', s.planned_tz, 'list_name', s.list_name)
    from email_planned_sends s where s.tenant_id = p_tenant_id and s.id = p_id;
$$;
revoke all on function public.email_planned_send_row(uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_planned_send_row(uuid, uuid) to service_role;

create or replace function public.list_email_planned_sends(p_tenant_id uuid, p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_role text;
begin
  if p_user_id is not null then
    v_role := public._email_plan_role(p_tenant_id, p_user_id);
    if v_role is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  end if;
  return jsonb_build_object('ok', true, 'role', v_role,
    'next_plan_at', (select next_run_at from email_plan_schedule where tenant_id = p_tenant_id),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'route', s.route, 'list_id', s.list_id, 'list_name', s.list_name, 'planned_at', s.planned_at,
               'timezone', s.planned_tz, 'angle', s.angle, 'why', s.why, 'source', s.source, 'status', s.status,
               'status_reason', s.status_reason, 'content_version', s.content_version, 'schedule_gen', s.schedule_gen,
               'card', case when s.card_id is null then null else jsonb_build_object('rail', s.card_rail, 'id', s.card_id) end,
               'vetoed', s.vetoed_at is not null,
               'scheduled', case when s.sched_at is null then null
                 else jsonb_build_object('variant', s.sched_variant, 'count', s.sched_count, 'by', s.sched_by, 'at', s.sched_at) end,
               'unattended', s.unattended, 'sent_at', s.sent_at,
               'draft_requested', exists (select 1 from email_plan_jobs j
                                           where j.tenant_id = s.tenant_id and j.item_id = s.id and j.kind = 'draft'
                                             and j.state <> 'done' and j.job_key like '%:now'),
               'hold', (select jsonb_build_object('since', r.reserved_at,
                                                  'unresolved', public._email_hold_unresolved(r.tenant_id, r.card_rail, r.card_id))
                          from email_send_reservations r
                         where r.tenant_id = s.tenant_id and r.card_rail = s.card_rail and r.card_id = s.card_id and r.state = 'held'))
             order by s.planned_at)
        from email_planned_sends s
       where s.tenant_id = p_tenant_id
         and (s.status in ('planned', 'drafting', 'ready', 'scheduled', 'sending', 'reconciling', 'blocked')
              or s.planned_at > now() - interval '7 days')
         and s.planned_at < now() + interval '15 days'), '[]'::jsonb),
    'holds', coalesce((
      select jsonb_agg(jsonb_build_object('rail', r.card_rail, 'card_id', r.card_id, 'list_key', r.list_key, 'since', r.reserved_at)
                       order by r.reserved_at)
        from (select * from email_send_reservations r
               where r.tenant_id = p_tenant_id and r.state = 'held'
                 and not exists (select 1 from email_planned_sends s
                                  where s.tenant_id = r.tenant_id and s.card_rail = r.card_rail and s.card_id = r.card_id)
                 and public._email_hold_unresolved(r.tenant_id, r.card_rail, r.card_id)
               order by r.reserved_at limit 20) r), '[]'::jsonb),
    'released', coalesce((
      select jsonb_agg(distinct l.card_id)
        from email_send_release_log l
       where l.tenant_id = p_tenant_id and l.released_at > now() - interval '14 days'), '[]'::jsonb));
end $$;
revoke all on function public.list_email_planned_sends(uuid, uuid) from public, anon, authenticated;
grant execute on function public.list_email_planned_sends(uuid, uuid) to service_role;

commit;
