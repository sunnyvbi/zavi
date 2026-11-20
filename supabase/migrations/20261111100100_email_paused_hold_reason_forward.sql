create or replace function public.start_email_send_result(
  p_tenant_id uuid, p_rail text, p_card_id uuid, p_row jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_found    boolean;
  v_class    text;
  v_id       uuid;
  v_route    text := p_row->>'route';
  v_finished timestamptz := (p_row->>'finished_at')::timestamptz;
  v_bulk     record;
  v_slug     text := left(p_row->>'campaign_slug', 120);
  v_shared   boolean := false;
  v_win      jsonb;
  v_other    record;
  v_new_start timestamptz := coalesce((p_row->>'started_at')::timestamptz, (p_row->>'finished_at')::timestamptz);
  v_lines    jsonb := '{}'::jsonb;
begin
  if p_tenant_id is null or p_card_id is null or p_row is null then
    return jsonb_build_object('ok', false, 'code', 'bad_args');
  end if;
  select o_found, o_class into v_found, v_class from public._email_card(p_tenant_id, p_rail, p_card_id, false);
  if not coalesce(v_found, false) then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if (v_class = 'bulk_outbound.send') <> (v_route = 'zavi_list') then
    return jsonb_build_object('ok', false, 'code', 'bad_route');
  end if;
  if v_route = 'zavi_list' then
    select s.id, s.status, s.hold_reason, s.sent into v_bulk
      from email_bulk_sends s
     where s.tenant_id = p_tenant_id and s.decision_id = p_card_id;
    if v_bulk.id is null or v_bulk.id::text <> p_row->>'provider_ref' then
      return jsonb_build_object('ok', false, 'code', 'not_found');
    end if;
    if v_bulk.status in ('sending', 'waiting_for_tomorrow')
       or (v_bulk.status = 'held' and coalesce(v_bulk.hold_reason, '') in
           ('abuse_complaints', 'abuse_bounces', 'provider_refused', 'bulk_check_failed', 'email_paused')) then
      return jsonb_build_object('ok', false, 'code', 'not_final');
    end if;
    if coalesce(v_bulk.sent, 0) <= 0 then
      return jsonb_build_object('ok', false, 'code', 'nothing_sent');
    end if;
  end if;
  if coalesce((p_row->>'sent_count')::int, 0) <= 0 then
    return jsonb_build_object('ok', false, 'code', 'nothing_sent');
  end if;

  if v_slug is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':slug:' || v_slug, 0));
    v_shared := exists (select 1 from email_send_results x
                         where x.tenant_id = p_tenant_id and x.campaign_slug = v_slug
                           and not (x.rail = p_rail and x.card_id = p_card_id));
  end if;

  v_win := coalesce(p_row->'win_line', '{}'::jsonb);
  if v_shared and v_win->>'metric' = 'visitors' then
    v_win := public._email_win_line(p_tenant_id, v_route, left(p_row->>'list_id', 128),
                                     case when v_route = 'zavi_list' then null else 'clicks' end, v_slug);
  end if;

  insert into email_send_results (
    tenant_id, rail, card_id, route, provider_ref, account_ref, campaign_title, list_id, list_name,
    subject, campaign_slug, shared_tag, sent_count, total_count, started_at, finished_at,
    ga_property_id, win_line
  ) values (
    p_tenant_id, p_rail, p_card_id, v_route, p_row->>'provider_ref', p_row->'account_ref',
    left(p_row->>'campaign_title', 300), left(p_row->>'list_id', 128), left(p_row->>'list_name', 300),
    left(coalesce(p_row->>'subject', ''), 300), v_slug, v_shared,
    (p_row->>'sent_count')::int, nullif(p_row->>'total_count', '')::int,
    coalesce((p_row->>'started_at')::timestamptz, v_finished), v_finished,
    left(p_row->>'ga_property_id', 40),
    v_win
  )
  on conflict (rail, card_id) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from email_send_results where rail = p_rail and card_id = p_card_id;
    return jsonb_build_object('ok', true, 'created', false, 'id', v_id);
  end if;
  if v_shared then
    perform 1 from email_send_results
     where tenant_id = p_tenant_id and campaign_slug = v_slug
       and (d7_published_at is null
            or (started_at <= v_new_start and v_new_start < finished_at + interval '9 days'))
     order by id
     for update;
    select coalesce(jsonb_object_agg(x.id::text,
             case when x.id <> v_id and x.win_line->>'metric' = 'visitors'
                  then public._email_win_line(p_tenant_id, x.route, x.list_id,
                                              case when x.route = 'zavi_list' then null else 'clicks' end, v_slug)
                  else x.win_line end), '{}'::jsonb)
      into v_lines
      from email_send_results x
     where x.tenant_id = p_tenant_id and x.campaign_slug = v_slug
       and (x.d7_published_at is null
            or (x.started_at <= v_new_start and v_new_start < x.finished_at + interval '9 days'));
    for v_other in
      select id, d7 from email_send_results
       where id in (select k::uuid from jsonb_object_keys(v_lines) k)
       order by id
    loop
      update email_send_results
         set shared_tag = true,
             d7 = d7 || jsonb_build_object('visitors', null, 'ga_status', 'shared_tag'),
             win_line = v_lines->(v_other.id::text),
             updated_at = now()
       where id = v_other.id;
      update email_result_tasks set state = 'gave_up', last_error = 'shared_tag',
             lease_token = null, lease_until = null, updated_at = now()
       where result_id = v_other.id and source = 'ga' and state in ('pending', 'waiting');
      if v_other.id <> v_id then
        perform public._email_result_finalize(v_other.id, v_other.d7);
      end if;
    end loop;
  end if;

  insert into email_result_tasks (tenant_id, result_id, source, stage, due_at, give_up_at, group_key) values
    (p_tenant_id, v_id, 'provider', 'h1', v_finished + interval '1 hour', v_finished + interval '13 hours', p_row->>'provider_group'),
    (p_tenant_id, v_id, 'provider', 'd7', v_finished + interval '7 days', v_finished + interval '10 days', p_row->>'provider_group');
  if v_slug is not null and not v_shared then
    insert into email_result_tasks (tenant_id, result_id, source, stage, due_at, give_up_at, group_key) values
      (p_tenant_id, v_id, 'ga', 'd7', v_finished + interval '7 days 12 hours', v_finished + interval '10 days 12 hours', 'ga:' || p_tenant_id::text);
  end if;
  return jsonb_build_object('ok', true, 'created', true, 'id', v_id);
end $$;
revoke all on function public.start_email_send_result(uuid, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.start_email_send_result(uuid, text, uuid, jsonb) to service_role;

create or replace function public.email_results_missing(p_since timestamptz, p_limit int)
returns table (tenant_id uuid, rail text, card_id uuid, sent int)
language sql security definer set search_path = public, pg_temp as $$
  select m.tenant_id, m.rail, m.card_id, m.sent from (
    (select c.tenant_id, 'channel_actions'::text as rail, c.id as card_id, null::int as sent, c.executed_at as at
       from channel_actions c
      where c.exec_class = 'email_campaign.create_and_send' and c.exec_status = 'executed'
        and c.executed_at >= p_since
        and jsonb_typeof(c.exec_payload->'variants') = 'array'
        and not exists (select 1 from email_send_results x where x.rail = 'channel_actions' and x.card_id = c.id)
      order by c.executed_at
      limit greatest(1, least(coalesce(p_limit, 100), 500)))
    union all
    (select r.tenant_id, 'decisions'::text, r.card_id, null::int, r.recorded_at
       from email_send_refs r
       join decisions d on d.id = r.card_id and d.tenant_id = r.tenant_id
      where r.rail = 'decisions' and r.recorded_at >= p_since and d.status = 'acted'
        and not exists (select 1 from email_send_results x where x.rail = 'decisions' and x.card_id = r.card_id)
      order by r.recorded_at
      limit greatest(1, least(coalesce(p_limit, 100), 500)))
    union all
    (select s.tenant_id, 'decisions'::text, s.decision_id, s.sent, s.created_at
       from email_bulk_sends s
      where s.sent > 0 and s.created_at >= p_since
        and (s.status in ('done', 'failed')
             or (s.status = 'held' and coalesce(s.hold_reason, '') not in
                 ('abuse_complaints', 'abuse_bounces', 'provider_refused', 'bulk_check_failed', 'email_paused')))
        and not exists (select 1 from email_send_results x where x.rail = 'decisions' and x.card_id = s.decision_id)
      order by s.created_at
      limit greatest(1, least(coalesce(p_limit, 100), 500)))
  ) m
  order by m.at
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;
revoke all on function public.email_results_missing(timestamptz, int) from public, anon, authenticated;
grant execute on function public.email_results_missing(timestamptz, int) to service_role;
