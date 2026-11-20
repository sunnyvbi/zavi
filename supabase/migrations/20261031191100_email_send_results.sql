
begin;

create table if not exists public.email_send_refs (
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  rail         text not null check (rail in ('channel_actions', 'decisions')),
  card_id      uuid not null,
  route        text not null check (route in ('sendgrid', 'mailchimp', 'klaviyo')),
  provider_ref text not null check (char_length(provider_ref) between 1 and 128),
  recorded_at  timestamptz not null default now(),
  primary key (rail, card_id)
);
alter table public.email_send_refs enable row level security;
revoke all on public.email_send_refs from public, anon, authenticated;
grant all on public.email_send_refs to service_role;

create or replace function public.record_email_send_ref(
  p_tenant_id uuid, p_rail text, p_card_id uuid, p_route text, p_provider_ref text
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_found boolean;
begin
  if p_tenant_id is null or p_card_id is null or p_provider_ref is null then return false; end if;
  select o_found into v_found from public._email_card(p_tenant_id, p_rail, p_card_id, false);
  if not coalesce(v_found, false) then return false; end if;
  insert into email_send_refs (tenant_id, rail, card_id, route, provider_ref)
  values (p_tenant_id, p_rail, p_card_id, p_route, p_provider_ref)
  on conflict (rail, card_id) do update
    set provider_ref = excluded.provider_ref, route = excluded.route, recorded_at = now()
    where email_send_refs.tenant_id = excluded.tenant_id;
  return true;
end $$;
revoke all on function public.record_email_send_ref(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_email_send_ref(uuid, text, uuid, text, text) to service_role;

create table if not exists public.email_send_results (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  rail            text not null check (rail in ('channel_actions', 'decisions')),
  card_id         uuid not null,
  route           text not null check (route in ('sendgrid', 'mailchimp', 'klaviyo', 'zavi_list')),
  provider_ref    text not null check (char_length(provider_ref) between 1 and 128),
  account_ref     jsonb,
  campaign_title  text,
  list_id         text,
  list_name       text,
  subject         text not null default '',
  campaign_slug   text,
  shared_tag      boolean not null default false,
  sent_count      int not null check (sent_count > 0),
  total_count     int,
  started_at      timestamptz not null,
  finished_at     timestamptz not null,
  ga_property_id  text,
  ga_timezone     text,
  win_line        jsonb not null default '{}'::jsonb,
  h1              jsonb not null default '{}'::jsonb,
  d7              jsonb not null default '{}'::jsonb,
  d7_published_at timestamptz,
  verdict         text check (verdict in ('beat', 'below', 'baseline', 'no_signal', 'unknown')),
  note            text check (note is null or char_length(note) <= 300),
  d7_told_at      timestamptz,
  d7_version      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint email_send_results_card_key unique (rail, card_id),
  constraint email_send_results_tenant_id_id_key unique (tenant_id, id)
);
create index if not exists email_send_results_tenant_finished_idx
  on public.email_send_results (tenant_id, finished_at desc);
create index if not exists email_send_results_baseline_idx
  on public.email_send_results (tenant_id, route, list_id, d7_published_at desc)
  where d7_published_at is not null;
create index if not exists email_send_results_untold_idx
  on public.email_send_results (tenant_id, d7_published_at)
  where d7_published_at is not null and d7_told_at is null;
alter table public.email_send_results enable row level security;
revoke all on public.email_send_results from public, anon, authenticated;
grant all on public.email_send_results to service_role;

create table if not exists public.email_result_tasks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  result_id   uuid not null,
  source      text not null check (source in ('provider', 'ga')),
  stage       text not null check (stage in ('h1', 'd7')),
  state       text not null default 'pending' check (state in ('pending', 'waiting', 'done', 'gave_up')),
  due_at      timestamptz not null,
  give_up_at  timestamptz not null,
  attempts    int not null default 0,
  group_key   text not null check (char_length(group_key) between 1 and 200),
  lease_token uuid,
  lease_until timestamptz,
  last_error  text check (last_error is null or char_length(last_error) <= 300),
  alerted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint email_result_tasks_key unique (result_id, source, stage),
  constraint email_result_tasks_result_fk foreign key (tenant_id, result_id)
    references public.email_send_results (tenant_id, id) on delete cascade
);
create index if not exists email_result_tasks_due_idx
  on public.email_result_tasks (due_at) where state in ('pending', 'waiting');
create index if not exists email_result_tasks_lease_idx
  on public.email_result_tasks (lease_until) where state in ('pending', 'waiting') and lease_until is not null;
create index if not exists email_result_tasks_result_idx
  on public.email_result_tasks (tenant_id, result_id);
alter table public.email_result_tasks enable row level security;
revoke all on public.email_result_tasks from public, anon, authenticated;
grant all on public.email_result_tasks to service_role;

create or replace function public._email_result_verdict(p_win jsonb, p_d7 jsonb)
returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v_metric text := p_win->>'metric';
  v_basis  text := p_win->>'basis';
  v_value  numeric;
  v_deliv  numeric;
  v_thr    numeric;
begin
  if v_metric is null then
    return case when v_basis = 'first_sends' then 'baseline' else 'no_signal' end;
  end if;
  if v_basis = 'first_sends' then return 'baseline'; end if;
  v_value := nullif(p_d7->>v_metric, '')::numeric;
  v_deliv := nullif(p_d7->>'delivered', '')::numeric;
  v_thr := nullif(p_win->>'threshold', '')::numeric;
  if v_value is null or v_deliv is null or v_deliv <= 0 or v_thr is null then return 'unknown'; end if;
  return case when v_value / v_deliv >= v_thr then 'beat' else 'below' end;
end $$;
revoke all on function public._email_result_verdict(jsonb, jsonb) from public, anon, authenticated;

create or replace function public._email_result_carry(p_h1 jsonb, p_d7 jsonb)
returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v_out  jsonb := coalesce(p_d7, '{}'::jsonb);
  v_from jsonb := '[]'::jsonb;
  k      text;
begin
  if coalesce(v_out->>'provider_status', '') not in ('could_not_read', 'disconnected') then
    return v_out;
  end if;
  foreach k in array array['recipients', 'delivered', 'opens', 'machine_opens', 'clicks', 'unsubscribes'] loop
    if jsonb_typeof(p_h1->k) = 'number' and coalesce(jsonb_typeof(v_out->k), 'null') = 'null' then
      v_out := v_out || jsonb_build_object(k, p_h1->k);
      v_from := v_from || to_jsonb(k);
    end if;
  end loop;
  if jsonb_array_length(v_from) > 0 then
    v_out := v_out || jsonb_build_object('from_h1', v_from);
  end if;
  return v_out;
end $$;
revoke all on function public._email_result_carry(jsonb, jsonb) from public, anon, authenticated;

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

create or replace function public._email_result_finalize(p_result_id uuid, p_old_d7 jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r       email_send_results%rowtype;
  v_open  int;
  v_d7    jsonb;
begin
  select * into r from email_send_results where id = p_result_id;
  if r.id is null then return; end if;
  if r.d7_published_at is null then
    select count(*) into v_open from email_result_tasks
     where result_id = r.id and stage = 'd7' and state in ('pending', 'waiting');
    if v_open = 0 then
      v_d7 := public._email_result_carry(r.h1, r.d7);
      update email_send_results
         set d7 = v_d7, d7_published_at = now(), verdict = public._email_result_verdict(win_line, v_d7),
             d7_version = d7_version + 1, updated_at = now()
       where id = r.id;
    end if;
  elsif r.d7 is distinct from p_old_d7 then
    update email_send_results
       set verdict = public._email_result_verdict(r.win_line, r.d7),
           d7_version = d7_version + 1, d7_told_at = null, updated_at = now()
     where id = r.id;
  end if;
end $$;
revoke all on function public._email_result_finalize(uuid, jsonb) from public, anon, authenticated;

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

create or replace function public.claim_email_result_tasks(p_limit int, p_lease_seconds int)
returns setof jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  with due as (
    select t.id
      from email_result_tasks t
     where t.state in ('pending', 'waiting')
       and t.due_at <= now()
       and (t.lease_until is null or t.lease_until < now())
     order by t.due_at
     limit greatest(1, least(coalesce(p_limit, 100), 500))
     for update skip locked
  ), leased as (
    update email_result_tasks t
       set lease_token = gen_random_uuid(),
           lease_until = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 600), 1800))),
           updated_at = now()
      from due
     where t.id = due.id
    returning t.*
  )
  select jsonb_build_object(
    'task_id', l.id, 'lease_token', l.lease_token, 'tenant_id', l.tenant_id, 'source', l.source,
    'stage', l.stage, 'state', l.state, 'attempts', l.attempts, 'group_key', l.group_key,
    'give_up_at', l.give_up_at,
    'result_id', r.id, 'rail', r.rail, 'card_id', r.card_id, 'route', r.route,
    'provider_ref', r.provider_ref, 'account_ref', r.account_ref, 'campaign_title', r.campaign_title,
    'campaign_slug', r.campaign_slug, 'started_at', r.started_at, 'finished_at', r.finished_at,
    'ga_property_id', r.ga_property_id, 'ga_timezone', r.ga_timezone
  )
    from leased l
    join email_send_results r on r.tenant_id = l.tenant_id and r.id = l.result_id;
end $$;
revoke all on function public.claim_email_result_tasks(int, int) from public, anon, authenticated;
grant execute on function public.claim_email_result_tasks(int, int) to service_role;

create or replace function public.complete_email_result_task(
  p_tenant_id uuid, p_task_id uuid, p_lease_token uuid, p_outcome text,
  p_result jsonb, p_next_due timestamptz, p_error text, p_ga jsonb, p_note text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t        email_result_tasks%rowtype;
  r        email_send_results%rowtype;
  v_state  text;
  v_merge  jsonb := coalesce(p_result, '{}'::jsonb);
  v_old_d7 jsonb;
  v_rid    uuid;
begin
  select result_id into v_rid from email_result_tasks where id = p_task_id and tenant_id = p_tenant_id;
  if v_rid is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  perform 1 from email_send_results where tenant_id = p_tenant_id and id = v_rid for update;
  select * into t from email_result_tasks
   where id = p_task_id and tenant_id = p_tenant_id for update;
  if t.id is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if t.lease_token is distinct from p_lease_token then
    return jsonb_build_object('ok', false, 'code', 'not_owner');
  end if;
  select * into r from email_send_results where tenant_id = p_tenant_id and id = t.result_id for update;
  v_old_d7 := r.d7;

  if t.source = 'ga' and p_ga ? 'property_id' then
    if r.ga_property_id is not null and r.ga_property_id <> p_ga->>'property_id' then
      update email_result_tasks set lease_token = null, lease_until = null, state = 'gave_up',
             last_error = 'ga_property_changed', updated_at = now() where id = t.id;
      v_merge := jsonb_build_object('visitors', null, 'ga_status', 'property_changed');
      p_outcome := 'gave_up_merged';
    else
      update email_send_results
         set ga_property_id = coalesce(ga_property_id, left(p_ga->>'property_id', 40)),
             ga_timezone = coalesce(ga_timezone, left(nullif(p_ga->>'timezone', ''), 64))
       where id = r.id;
    end if;
  end if;

  if p_outcome = 'done' then
    v_state := 'done';
  elsif p_outcome = 'waiting' then
    v_state := case when coalesce(p_next_due, now()) > t.give_up_at then 'gave_up' else 'waiting' end;
  elsif p_outcome = 'rate_limited' then
    v_state := 'pending';
  elsif p_outcome = 'retry' then
    v_state := case when coalesce(p_next_due, now()) >= t.give_up_at then 'gave_up' else 'pending' end;
  elsif p_outcome in ('gave_up', 'gave_up_merged', 'disconnected') then
    v_state := 'gave_up';
  else
    return jsonb_build_object('ok', false, 'code', 'bad_outcome');
  end if;

  if p_outcome <> 'gave_up_merged' then
    update email_result_tasks
       set state = v_state,
           due_at = case when v_state in ('pending', 'waiting') then coalesce(p_next_due, now() + interval '10 minutes') else due_at end,
           attempts = attempts + case when p_outcome = 'retry' then 1 else 0 end,
           last_error = case when p_outcome in ('retry', 'gave_up', 'disconnected') then left(p_error, 300) else last_error end,
           lease_token = null, lease_until = null, updated_at = now()
     where id = t.id;
  end if;

  if v_state = 'gave_up' and p_outcome in ('retry', 'gave_up', 'disconnected') then
    v_merge := v_merge || jsonb_build_object(t.source || '_status', case when p_outcome = 'disconnected' then 'disconnected' else 'could_not_read' end);
  end if;
  if v_state = 'done' then
    v_merge := v_merge || jsonb_build_object(t.source || '_status', 'ok', t.source || '_as_of', now());
  end if;
  if v_merge <> '{}'::jsonb and v_state <> 'pending' then
    if t.stage = 'h1' then
      update email_send_results set h1 = h1 || v_merge, updated_at = now() where id = r.id;
    else
      update email_send_results set d7 = d7 || v_merge, updated_at = now() where id = r.id;
    end if;
  end if;

  if p_outcome = 'disconnected' then
    update email_result_tasks set state = 'gave_up', last_error = left(coalesce(p_error, 'disconnected'), 300),
           lease_token = null, lease_until = null, updated_at = now()
     where result_id = r.id and source = 'provider' and state in ('pending', 'waiting') and id <> t.id;
    update email_send_results
       set d7 = d7 || jsonb_build_object('provider_status', 'disconnected'),
           note = coalesce(left(p_note, 300), note), updated_at = now()
     where id = r.id;
  elsif p_note is not null then
    update email_send_results set note = left(p_note, 300), updated_at = now() where id = r.id;
  end if;

  perform public._email_result_finalize(r.id, v_old_d7);
  return jsonb_build_object('ok', true, 'state', v_state);
end $$;
revoke all on function public.complete_email_result_task(uuid, uuid, uuid, text, jsonb, timestamptz, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.complete_email_result_task(uuid, uuid, uuid, text, jsonb, timestamptz, text, jsonb, text) to service_role;

create or replace function public.email_results_backlog(p_stuck_after_hours int)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_count  int;
  v_oldest timestamptz;
  v_newly  jsonb;
begin
  select count(*), min(due_at) into v_count, v_oldest
    from email_result_tasks where state = 'pending' and due_at <= now();
  with stuck as (
    select id from email_result_tasks
     where state = 'pending' and alerted_at is null
       and due_at <= now() - make_interval(hours => greatest(1, coalesce(p_stuck_after_hours, 72)))
     order by due_at limit 50
     for update skip locked
  ), marked as (
    update email_result_tasks t set alerted_at = now() from stuck where t.id = stuck.id
    returning t.tenant_id, t.source, t.stage, t.last_error
  )
  select coalesce(jsonb_agg(jsonb_build_object('tenant_id', tenant_id, 'source', source, 'stage', stage, 'last_error', last_error)), '[]'::jsonb)
    into v_newly from marked;
  return jsonb_build_object('due', v_count, 'oldest_due_at', v_oldest, 'newly_stuck', v_newly);
end $$;
revoke all on function public.email_results_backlog(int) from public, anon, authenticated;
grant execute on function public.email_results_backlog(int) to service_role;

create or replace function public.mark_email_results_told(p_tenant_id uuid, p_marks jsonb)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  if p_marks is null or jsonb_typeof(p_marks) <> 'array' then return 0; end if;
  update email_send_results x set d7_told_at = now()
    from (select (m->>'id')::uuid as id, (m->>'version')::int as version
            from jsonb_array_elements(p_marks) m
           where m->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             and m->>'version' ~ '^[0-9]{1,9}$') w
   where x.tenant_id = p_tenant_id and x.id = w.id and x.d7_version = w.version
     and x.d7_told_at is null and x.d7_published_at is not null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.mark_email_results_told(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.mark_email_results_told(uuid, jsonb) to service_role;

create index if not exists channel_actions_email_executed_idx
  on public.channel_actions (executed_at)
  where exec_class = 'email_campaign.create_and_send' and exec_status = 'executed';
create index if not exists email_bulk_sends_sent_created_idx
  on public.email_bulk_sends (created_at) where sent > 0;
create index if not exists email_send_refs_recorded_idx
  on public.email_send_refs (recorded_at);

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

create or replace function public.email_bulk_send_resumed_drop_result()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.status = 'held' and new.status = 'sending' then
    delete from email_send_results
     where tenant_id = new.tenant_id and rail = 'decisions' and card_id = new.decision_id;
  end if;
  return new;
end $$;
revoke all on function public.email_bulk_send_resumed_drop_result() from public, anon, authenticated;
drop trigger if exists email_bulk_send_resumed_drop_result on public.email_bulk_sends;
create trigger email_bulk_send_resumed_drop_result
  after update of status on public.email_bulk_sends
  for each row execute function public.email_bulk_send_resumed_drop_result();

commit;
