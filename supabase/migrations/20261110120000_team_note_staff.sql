
begin;

set lock_timeout = '5s';

create or replace function public.team_note_judgement_summary(p_days integer)
returns table (agent_slug text, code_signal text, judge_signal text, source text,
               surface text, verdict text, n bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  if p_days is null or p_days not in (7, 30) then
    raise exception 'team_note: days must be 7 or 30' using errcode = '22023';
  end if;
  return query
  select j.agent_slug, coalesce(j.signals[1], 'none'), j.judge_signal, j.source, j.surface, j.verdict,
         count(*)::bigint
    from team_note_judgements j
   where j.created_at >= now() - make_interval(days => p_days)
   group by 1, 2, 3, 4, 5, 6
   order by 7 desc, 1, 2, 3, 4, 5, 6;
end $$;
revoke all on function public.team_note_judgement_summary(integer) from public, anon, authenticated;
grant execute on function public.team_note_judgement_summary(integer) to service_role;

create or replace function public.team_note_offer_summary(p_days integer)
returns table (agent_slug text, code_signal text, judge_signal text, source text,
               surface text, status text, n bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  if p_days is null or p_days not in (7, 30) then
    raise exception 'team_note: days must be 7 or 30' using errcode = '22023';
  end if;
  return query
  select o.agent_slug, coalesce(o.signals[1], 'none'), o.signal, o.source, o.surface, o.status,
         count(*)::bigint
    from team_note_offers o
   where o.drafted_at >= now() - make_interval(days => p_days)
   group by 1, 2, 3, 4, 5, 6
   order by 7 desc, 1, 2, 3, 4, 5, 6;
end $$;
revoke all on function public.team_note_offer_summary(integer) from public, anon, authenticated;
grant execute on function public.team_note_offer_summary(integer) to service_role;

create index if not exists team_reports_created_id on public.team_reports (created_at desc, id desc);

create or replace function public.team_reports_staff_list(
  p_before_created timestamptz, p_before_id uuid, p_limit integer
) returns table (id uuid, tenant_id uuid, tenant_slug text, tenant_name text, agent_slug text,
                 signal text, source text, created_at timestamptz, has_extra boolean,
                 note_edited boolean, status text, thread_id uuid, message_id uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  if (p_before_created is null) <> (p_before_id is null) then
    raise exception 'team_note: cursor needs both parts' using errcode = '22023';
  end if;
  return query
  select r.id, r.tenant_id, t.slug, t.display_name, r.agent_slug, r.signal, r.source, r.created_at,
         r.founder_extra is not null, r.note_edited, r.status, r.thread_id, r.message_id
    from team_reports r
    left join tenants t on t.id = r.tenant_id
   where p_before_created is null
      or (r.created_at, r.id) < (p_before_created, p_before_id)
   order by r.created_at desc, r.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
end $$;
revoke all on function public.team_reports_staff_list(timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function public.team_reports_staff_list(timestamptz, uuid, integer) to service_role;

create table if not exists public.team_report_pings (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  window_start    timestamptz not null,
  agent_slug      text not null check (char_length(agent_slug) between 1 and 64),
  signal          text not null check (signal ~ '^[a-z_]{1,40}$'),
  send_count      integer not null default 1 check (send_count >= 1),
  status          text not null default 'pending'
                    check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts        integer not null default 0 check (attempts >= 0),
  last_error      text check (last_error is null or char_length(last_error) <= 500),
  next_attempt_at timestamptz not null,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  constraint team_report_pings_one_per_window unique (tenant_id, window_start)
);
create index if not exists team_report_pings_due
  on public.team_report_pings (next_attempt_at) where status in ('pending', 'sending');
create index if not exists team_report_pings_purge on public.team_report_pings (created_at);

alter table public.team_report_pings enable row level security;
revoke all on public.team_report_pings from public, anon, authenticated;
revoke all on public.team_report_pings from service_role;
grant select on public.team_report_pings to service_role;

comment on table public.team_report_pings is
  'Slack ping per tenant per 10-minute window of founder-sent team reports. Ids, codes and counts only: never note text. 20261110120000.';

create or replace function public._team_report_ping_enqueue(p_tenant_id uuid, p_agent_slug text, p_signal text)
returns bigint
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_window timestamptz := date_bin('10 minutes', clock_timestamp(), timestamptz '2000-01-01 00:00:00+00');
  v_id bigint;
begin
  for i in 1..6 loop
    insert into team_report_pings (tenant_id, window_start, agent_slug, signal, next_attempt_at)
    values (p_tenant_id, v_window, left(p_agent_slug, 64), p_signal, v_window + interval '10 minutes')
    on conflict (tenant_id, window_start) do update
      set send_count = team_report_pings.send_count + 1,
          agent_slug = excluded.agent_slug,
          signal = excluded.signal
      where team_report_pings.status = 'pending'
    returning id into v_id;
    if v_id is not null then return v_id; end if;
    v_window := v_window + interval '10 minutes';
  end loop;
  return null;
end $$;
revoke all on function public._team_report_ping_enqueue(uuid, text, text) from public, anon, authenticated;

create or replace function public.team_note_send(
  p_tenant_id uuid, p_actor uuid, p_message_id uuid, p_note text, p_extra text,
  p_retention_days integer
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v record;
  o record;
  v_note text := btrim(coalesce(p_note, ''));
  v_extra text := nullif(btrim(coalesce(p_extra, '')), '');
  v_report_id uuid;
  v_ping_id bigint;
begin
  perform _team_note_assert_member(p_tenant_id, p_actor);
  select * into v from _team_note_message_ctx(p_tenant_id, p_message_id);
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v.user_id is distinct from p_actor then
    raise exception 'team_note: not your chat' using errcode = '42501';
  end if;
  select * into o from team_note_offers
   where tenant_id = p_tenant_id and message_id = p_message_id for update;
  if not found then return jsonb_build_object('status', 'not_offered'); end if;
  if o.status = 'sent' then
    select id into v_report_id from team_reports where tenant_id = p_tenant_id and offer_id = o.id;
    return jsonb_build_object('status', 'sent', 'report_id', v_report_id,
                              'signal', o.signal, 'source', o.source, 'first', false);
  end if;
  if o.status <> 'shown' then return jsonb_build_object('status', 'closed'); end if;
  if length(v_note) not between 1 and 1000 then
    raise exception 'team_note: note length out of bounds' using errcode = '22023';
  end if;
  if v_extra is not null and length(v_extra) > 2000 then
    raise exception 'team_note: extra length out of bounds' using errcode = '22023';
  end if;

  insert into team_reports (tenant_id, user_id, offer_id, thread_id, message_id, run_id,
                            agent_slug, source, signal, signals, fingerprint, note, founder_extra,
                            note_edited, expires_at)
  values (p_tenant_id, p_actor, o.id, v.thread_id, p_message_id, v.run_id, v.agent_slug,
          o.source, o.signal, o.signals, o.fingerprint, v_note, v_extra,
          v_note is distinct from (v.meta -> 'team_note_draft' ->> 'note'),
          now() + make_interval(days => least(greatest(coalesce(p_retention_days, 180), 1), 180)))
  returning id into v_report_id;
  update team_note_offers set status = 'sent', resolved_at = clock_timestamp()
   where tenant_id = p_tenant_id and id = o.id;
  perform _team_note_merge_meta(p_message_id, jsonb_build_object('team_note_state', 'sent'));
  v_ping_id := _team_report_ping_enqueue(p_tenant_id, v.agent_slug, o.signal);
  return jsonb_build_object('status', 'sent', 'report_id', v_report_id,
                            'signal', o.signal, 'source', o.source, 'first', true,
                            'ping_id', v_ping_id);
end $$;
revoke all on function public.team_note_send(uuid, uuid, uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.team_note_send(uuid, uuid, uuid, text, text, integer) to service_role;

create or replace function public.claim_team_report_pings(p_limit integer)
returns table (id bigint, tenant_id uuid, tenant_slug text, agent_slug text, signal text,
               send_count integer, attempts integer, window_start timestamptz)
language plpgsql volatile security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  return query
  with claimed as (
    update team_report_pings p
       set status = 'sending', attempts = p.attempts + 1, next_attempt_at = clock_timestamp() + interval '15 minutes'
     where p.id in (select q.id from team_report_pings q
                     where q.status in ('pending', 'sending') and q.next_attempt_at <= now()
                     order by q.next_attempt_at, q.id
                     limit least(greatest(coalesce(p_limit, 50), 1), 200)
                     for update skip locked)
    returning p.*
  )
  select c.id, c.tenant_id, coalesce(t.slug, c.tenant_id::text), c.agent_slug, c.signal,
         c.send_count, c.attempts, c.window_start
    from claimed c left join tenants t on t.id = c.tenant_id
   order by c.id;
end $$;
revoke all on function public.claim_team_report_pings(integer) from public, anon, authenticated;
grant execute on function public.claim_team_report_pings(integer) to service_role;

create or replace function public.team_report_ping_due_at(p_id bigint)
returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
  select next_attempt_at from team_report_pings where id = p_id and status in ('pending', 'sending')
$$;
revoke all on function public.team_report_ping_due_at(bigint) from public, anon, authenticated;
grant execute on function public.team_report_ping_due_at(bigint) to service_role;

create or replace function public.finish_team_report_ping(
  p_id bigint, p_attempt integer, p_outcome text, p_error text
) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_n integer;
begin
  if p_outcome is null or p_outcome not in ('sent', 'skipped', 'retry', 'release') then
    raise exception 'team_report_ping: unknown outcome' using errcode = '22023';
  end if;
  update team_report_pings
     set status = case p_outcome when 'sent' then 'sent' when 'skipped' then 'skipped' when 'release' then 'pending'
                                 else case when attempts >= 6 then 'failed' else 'pending' end end,
         attempts = case when p_outcome = 'release' then greatest(attempts - 1, 0) else attempts end,
         sent_at = case when p_outcome = 'sent' then now() else sent_at end,
         last_error = case when p_outcome = 'release' then last_error else left(p_error, 500) end,
         next_attempt_at = case p_outcome
                             when 'retry' then now() + make_interval(secs => least(3600, 60 * power(2, greatest(attempts - 1, 0))))
                             when 'release' then now()
                             else next_attempt_at end
   where id = p_id and status = 'sending' and attempts = p_attempt;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;
revoke all on function public.finish_team_report_ping(bigint, integer, text, text) from public, anon, authenticated;
grant execute on function public.finish_team_report_ping(bigint, integer, text, text) to service_role;

create or replace function public.purge_expired_team_notes_v2(p_limit integer, p_offer_days integer)
returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_lim integer := least(greatest(coalesce(p_limit, 1000), 1), 10000);
  v_days integer := greatest(coalesce(p_offer_days, 400), 1);
  v_reports integer;
  v_offers integer;
  v_claims integer;
  v_judgements integer;
  v_pings integer;
  v_backlog bigint;
  v_oldest double precision;
begin
  with doomed as (
    select id from team_reports where expires_at < now()
     order by expires_at limit v_lim for update skip locked
  )
  delete from team_reports r using doomed d where r.id = d.id;
  get diagnostics v_reports = row_count;

  with doomed as (
    select o.id from team_note_offers o
     where o.drafted_at < now() - make_interval(days => v_days)
       and not exists (select 1 from team_reports r where r.offer_id = o.id)
     order by o.drafted_at limit v_lim for update skip locked
  )
  delete from team_note_offers o using doomed d where o.id = d.id;
  get diagnostics v_offers = row_count;

  with doomed as (
    select message_id from team_note_judge_claims
     where claimed_at < now() - make_interval(days => v_days)
     order by claimed_at limit v_lim for update skip locked
  )
  delete from team_note_judge_claims c using doomed d where c.message_id = d.message_id;
  get diagnostics v_claims = row_count;

  with doomed as (
    select id from team_note_judgements
     where created_at < now() - make_interval(days => v_days)
     order by created_at limit v_lim for update skip locked
  )
  delete from team_note_judgements j using doomed d where j.id = d.id;
  get diagnostics v_judgements = row_count;

  with doomed as (
    select id from team_report_pings
     where created_at < now() - interval '30 days' and status in ('sent', 'failed', 'skipped')
     order by created_at limit v_lim for update skip locked
  )
  delete from team_report_pings p using doomed d where p.id = d.id;
  get diagnostics v_pings = row_count;

  select count(*) into v_backlog from (
    select 1 from team_reports where expires_at < now() limit 100000
  ) b;
  select coalesce(extract(epoch from now() - min(expires_at)), 0) into v_oldest
    from team_reports where expires_at < now();

  return jsonb_build_object(
    'deleted', v_reports + v_offers + v_claims + v_judgements + v_pings,
    'backlog', v_backlog,
    'oldest_expired_seconds', v_oldest);
end $$;
revoke all on function public.purge_expired_team_notes_v2(integer, integer) from public, anon, authenticated;
grant execute on function public.purge_expired_team_notes_v2(integer, integer) to service_role;

commit;
