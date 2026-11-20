begin;

create or replace function public.change_email_planned_angle(
  p_tenant_id uuid, p_actor uuid, p_id uuid, p_angle text, p_expected_version int
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  l record;
  v_row email_planned_sends%rowtype;
  v_angle text := nullif(trim(coalesce(p_angle, '')), '');
  v_code text;
begin
  if p_actor is null or v_angle is null or length(v_angle) > 120 then return jsonb_build_object('ok', false, 'code', 'bad_request'); end if;
  select * into l from public._email_plan_lock_item(p_tenant_id, p_id, p_actor);
  if l.o_code is not null then return jsonb_build_object('ok', false, 'code', l.o_code); end if;
  v_row := l.o_row;
  if v_row.content_version is distinct from p_expected_version then return jsonb_build_object('ok', false, 'code', 'plan_changed'); end if;
  if v_row.planned_at <= now()
     or not (v_row.status in ('planned', 'drafting', 'ready', 'scheduled')
             or (v_row.status = 'blocked' and v_row.card_id is null
                 and coalesce(v_row.status_reason, '') in ('draft_blocked:channel_card_already_done', 'draft_blocked:channel_card_already_rejected'))) then
    return jsonb_build_object('ok', false, 'code', 'not_changeable', 'status', v_row.status);
  end if;
  if lower(btrim(v_row.angle)) = lower(v_angle) then
    return jsonb_build_object('ok', true, 'unchanged', true, 'content_version', v_row.content_version, 'schedule_gen', v_row.schedule_gen);
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
  if v_row.status = 'blocked' then
    v_code := public._email_plan_unblock_refusal(v_row);
    if v_code is not null then return jsonb_build_object('ok', false, 'code', v_code); end if;
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

create or replace function public._email_win_line(p_tenant_id uuid, p_route text, p_list_id text, p_metric text, p_exclude_slug text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_rates numeric[];
  v_n     int;
  v_med   numeric;
begin
  if p_metric is null then
    return jsonb_build_object('metric', null, 'threshold', null, 'basis', 'no_signal', 'n_past', 0);
  end if;
  if p_list_id is null then
    return jsonb_build_object('metric', p_metric, 'threshold', null, 'basis', 'first_sends', 'n_past', 0);
  end if;
  select array_agg(rate order by published desc) into v_rates from (
    select (x.d7->>p_metric)::numeric / (x.d7->>'delivered')::numeric as rate, x.d7_published_at as published
      from email_send_results x
     where x.tenant_id = p_tenant_id and x.route = p_route and x.list_id = p_list_id
       and x.d7_published_at is not null and x.win_line->>'metric' = p_metric
       and jsonb_typeof(x.d7->p_metric) = 'number' and jsonb_typeof(x.d7->'delivered') = 'number'
       and (x.d7->>'delivered')::numeric > 0
       and not (coalesce(x.d7->>'provider_status', '') in ('disconnected', 'could_not_read')
                and (coalesce(x.d7->'from_h1', '[]'::jsonb) ? 'delivered' or coalesce(x.d7->'from_h1', '[]'::jsonb) ? p_metric))
       and x.campaign_slug is distinct from p_exclude_slug
     order by x.d7_published_at desc
     limit 5
  ) last5;
  v_n := coalesce(array_length(v_rates, 1), 0);
  if v_n < 3 then
    return jsonb_build_object('metric', p_metric, 'threshold', null, 'basis', 'first_sends', 'n_past', v_n);
  end if;
  select percentile_cont(0.5) within group (order by u) into v_med from unnest(v_rates) u;
  return jsonb_build_object('metric', p_metric, 'threshold', round(v_med, 6), 'basis', 'median', 'n_past', v_n);
end $$;
revoke all on function public._email_win_line(uuid, text, text, text, text) from public, anon, authenticated;

commit;
