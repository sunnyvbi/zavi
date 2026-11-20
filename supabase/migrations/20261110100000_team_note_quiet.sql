
begin;

set lock_timeout = '5s';

alter table public.team_note_offers
  add column if not exists surface text not null default 'strip'
    check (surface in ('strip', 'flag')),
  add column if not exists shown_via text
    check (shown_via is null or shown_via in ('strip', 'flag')),
  add column if not exists anchor_message_id uuid
    references public.agent_thread_messages(id) on delete set null,
  add column if not exists capped_as text
    check (capped_as is null or capped_as = 'run_end_strip');

create index if not exists team_note_offers_capped_shown
  on public.team_note_offers (tenant_id, user_id, shown_at desc)
  where capped_as = 'run_end_strip';
create index if not exists team_note_offers_anchor
  on public.team_note_offers (anchor_message_id) where anchor_message_id is not null;

create table if not exists public.team_note_judgements (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  message_id    uuid references public.agent_thread_messages(id) on delete set null,
  run_id        uuid references public.agent_runs(id) on delete set null,
  agent_slug    text not null,
  source        text not null check (source in ('run_end', 'correction', 'rephrase', 'edit')),
  signals       text[] not null default '{}'
                  check (cardinality(signals) <= 20),
  verdict       text not null check (verdict in ('bad', 'no', 'transport', 'parse')),
  judge_signal  text check (judge_signal is null or judge_signal ~ '^[a-z_]{1,40}$'),
  surface       text check (surface is null or surface in ('strip', 'flag')),
  created_at    timestamptz not null default now()
);
create index if not exists team_note_judgements_created on public.team_note_judgements (created_at);
create index if not exists team_note_judgements_tenant_created
  on public.team_note_judgements (tenant_id, created_at);
create index if not exists team_note_judgements_message
  on public.team_note_judgements (message_id) where message_id is not null;
create index if not exists team_note_judgements_run
  on public.team_note_judgements (run_id) where run_id is not null;

alter table public.team_note_judgements enable row level security;
revoke all on public.team_note_judgements from public, anon, authenticated;
revoke all on public.team_note_judgements from service_role;
grant select on public.team_note_judgements to service_role;

create or replace function public._team_note_cap_reason_v2(
  p_tenant_id uuid, p_user_id uuid, p_thread_id uuid,
  p_max_per_thread integer, p_thread_window_hours integer, p_max_per_day integer
) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from team_note_prefs
              where tenant_id = p_tenant_id and user_id = p_user_id and suggestions_off) then
    return 'suggestions_off';
  end if;
  if (select count(*) from team_note_offers
       where tenant_id = p_tenant_id and thread_id = p_thread_id
         and capped_as = 'run_end_strip'
         and shown_at > now() - make_interval(hours => greatest(p_thread_window_hours, 1)))
     >= greatest(p_max_per_thread, 0) then
    return 'thread_cap';
  end if;
  if (select count(*) from team_note_offers
       where tenant_id = p_tenant_id and user_id = p_user_id
         and capped_as = 'run_end_strip'
         and shown_at > now() - interval '24 hours')
     >= greatest(p_max_per_day, 0) then
    return 'daily_cap';
  end if;
  return null;
end $$;
revoke all on function public._team_note_cap_reason_v2(uuid, uuid, uuid, integer, integer, integer) from public, anon, authenticated;

create or replace function public._team_note_suggestions_off(p_tenant_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from team_note_prefs
                  where tenant_id = p_tenant_id and user_id = p_user_id and suggestions_off)
$$;
revoke all on function public._team_note_suggestions_off(uuid, uuid) from public, anon, authenticated;

create or replace function public._team_note_anchor_ok(p_tenant_id uuid, p_thread_id uuid, p_anchor uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from agent_thread_messages
                  where id = p_anchor and tenant_id = p_tenant_id and thread_id = p_thread_id)
$$;
revoke all on function public._team_note_anchor_ok(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public.team_note_can_offer_v2(
  p_tenant_id uuid, p_message_id uuid,
  p_max_per_thread integer, p_thread_window_hours integer, p_max_per_day integer,
  p_apply_caps boolean
) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v record;
begin
  select * into v from _team_note_message_ctx(p_tenant_id, p_message_id);
  if not found or v.sender_role <> 'assistant' then return 'not_found'; end if;
  if exists (select 1 from team_note_offers
              where tenant_id = p_tenant_id and message_id = p_message_id) then
    return 'already_offered';
  end if;
  if coalesce(p_apply_caps, true) then
    return coalesce(
      _team_note_cap_reason_v2(p_tenant_id, v.user_id, v.thread_id,
                               p_max_per_thread, p_thread_window_hours, p_max_per_day),
      'ok');
  end if;
  if _team_note_suggestions_off(p_tenant_id, v.user_id) then return 'suggestions_off'; end if;
  return 'ok';
end $$;
revoke all on function public.team_note_can_offer_v2(uuid, uuid, integer, integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.team_note_can_offer_v2(uuid, uuid, integer, integer, integer, boolean) to service_role;

create or replace function public.team_note_claim_judgement_v2(
  p_tenant_id uuid, p_message_id uuid, p_source text, p_signals text[], p_run_hard_failed boolean
) returns text
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v record;
  v_hit uuid;
  v_allowed text[];
begin
  if p_source is null or p_source not in ('run_end', 'correction', 'rephrase', 'edit') then
    raise exception 'team_note: unknown source' using errcode = '22023';
  end if;
  select * into v from _team_note_message_ctx(p_tenant_id, p_message_id);
  if not found or v.sender_role <> 'assistant' then return 'not_found'; end if;

  insert into team_note_judge_claims (message_id, tenant_id, source, signals)
  values (p_message_id, p_tenant_id, p_source, coalesce(p_signals, '{}'))
  on conflict (message_id) do nothing
  returning message_id into v_hit;
  if v_hit is not null then return 'claimed'; end if;

  v_allowed := case p_source
    when 'correction' then array['run_end', 'rephrase', 'edit']
    when 'run_end' then case when coalesce(p_run_hard_failed, false) then array['correction'] else '{}'::text[] end
    else '{}'::text[]
  end;
  update team_note_judge_claims
     set source = p_source, signals = coalesce(p_signals, '{}'), claimed_at = now()
   where message_id = p_message_id and tenant_id = p_tenant_id
     and source = any(v_allowed)
     and not exists (select 1 from team_note_offers
                      where tenant_id = p_tenant_id and message_id = p_message_id)
  returning message_id into v_hit;
  if v_hit is not null then return 'upgraded'; end if;

  if exists (select 1 from team_note_offers
              where tenant_id = p_tenant_id and message_id = p_message_id) then
    return 'offered';
  end if;
  return 'taken';
end $$;
revoke all on function public.team_note_claim_judgement_v2(uuid, uuid, text, text[], boolean) from public, anon, authenticated;
grant execute on function public.team_note_claim_judgement_v2(uuid, uuid, text, text[], boolean) to service_role;

create or replace function public.team_note_offer_v2(
  p_tenant_id uuid, p_message_id uuid, p_source text, p_signal text, p_signals text[],
  p_fingerprint text, p_note text, p_surface text, p_anchor_message_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v record;
  v_offer_id uuid;
  v_note text := btrim(coalesce(p_note, ''));
begin
  if length(v_note) not between 1 and 400 then
    raise exception 'team_note: note length out of bounds' using errcode = '22023';
  end if;
  if p_surface is null or p_surface not in ('strip', 'flag') then
    raise exception 'team_note: unknown surface' using errcode = '22023';
  end if;
  if p_surface = 'strip' and p_anchor_message_id is null then
    raise exception 'team_note: a strip needs an anchor' using errcode = '22023';
  end if;
  select * into v from _team_note_message_ctx(p_tenant_id, p_message_id);
  if not found or v.sender_role <> 'assistant' then
    return jsonb_build_object('offered', false, 'reason', 'not_found');
  end if;
  if p_anchor_message_id is not null
     and not _team_note_anchor_ok(p_tenant_id, v.thread_id, p_anchor_message_id) then
    raise exception 'team_note: anchor is not in this thread' using errcode = '22023';
  end if;
  if _team_note_suggestions_off(p_tenant_id, v.user_id) then
    return jsonb_build_object('offered', false, 'reason', 'suggestions_off');
  end if;

  insert into team_note_offers (tenant_id, user_id, thread_id, message_id, run_id, agent_slug,
                                source, signal, signals, fingerprint, surface, anchor_message_id)
  values (p_tenant_id, v.user_id, v.thread_id, p_message_id, v.run_id, v.agent_slug,
          p_source, p_signal, coalesce(p_signals, '{}'), p_fingerprint, p_surface, p_anchor_message_id)
  on conflict (message_id) do nothing
  returning id into v_offer_id;
  if v_offer_id is null then
    return jsonb_build_object('offered', false, 'reason', 'already_offered');
  end if;

  perform _team_note_merge_meta(p_message_id, jsonb_build_object(
    'team_note_draft', jsonb_build_object(
      'offer_id', v_offer_id, 'note', v_note, 'signal', p_signal, 'offer_stop', false,
      'surface', p_surface, 'anchor_message_id', p_anchor_message_id),
    'team_note_state', 'drafted'));
  return jsonb_build_object('offered', true, 'offer_id', v_offer_id);
end $$;
revoke all on function public.team_note_offer_v2(uuid, uuid, text, text, text[], text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.team_note_offer_v2(uuid, uuid, text, text, text[], text, text, text, uuid) to service_role;

create or replace function public.team_note_promote_v2(
  p_tenant_id uuid, p_message_id uuid, p_anchor_message_id uuid, p_signals text[]
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v record;
  o record;
  v_status text;
begin
  if p_anchor_message_id is null then
    raise exception 'team_note: a strip needs an anchor' using errcode = '22023';
  end if;
  select * into v from _team_note_message_ctx(p_tenant_id, p_message_id);
  if not found or v.sender_role <> 'assistant' then
    return jsonb_build_object('promoted', false, 'reason', 'not_found');
  end if;
  if not _team_note_anchor_ok(p_tenant_id, v.thread_id, p_anchor_message_id) then
    raise exception 'team_note: anchor is not in this thread' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('team_note:' || p_tenant_id::text || ':' || v.user_id::text, 0));
  select * into o from team_note_offers
   where tenant_id = p_tenant_id and message_id = p_message_id for update;
  if not found then return jsonb_build_object('promoted', false, 'reason', 'not_offered'); end if;
  if o.status not in ('drafted', 'shown', 'suppressed') then
    return jsonb_build_object('promoted', false, 'reason', o.status);
  end if;
  if _team_note_suggestions_off(p_tenant_id, v.user_id) then
    return jsonb_build_object('promoted', false, 'reason', 'suggestions_off');
  end if;

  v_status := case when o.status = 'suppressed' then 'drafted' else o.status end;
  update team_note_offers
     set surface = 'strip', anchor_message_id = p_anchor_message_id, source = 'correction',
         signals = o.signals || array(select s from unnest(coalesce(p_signals, '{}')) s
                                       where not (s = any(o.signals))),
         status = v_status,
         resolved_at = case when o.status = 'suppressed' then null else o.resolved_at end
   where tenant_id = p_tenant_id and id = o.id;
  update agent_thread_messages
     set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
           'team_note_draft', coalesce(meta -> 'team_note_draft', '{}'::jsonb)
                              || jsonb_build_object('surface', 'strip', 'anchor_message_id', p_anchor_message_id),
           'team_note_state', v_status)
   where id = p_message_id and tenant_id = p_tenant_id;
  return jsonb_build_object('promoted', true, 'offer_id', o.id, 'status', v_status,
                            'signal', o.signal, 'source', 'correction');
end $$;
revoke all on function public.team_note_promote_v2(uuid, uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public.team_note_promote_v2(uuid, uuid, uuid, text[]) to service_role;

create or replace function public.team_note_mark_shown_v2(
  p_tenant_id uuid, p_actor uuid, p_message_id uuid,
  p_max_per_thread integer, p_thread_window_hours integer, p_max_per_day integer,
  p_stop_after integer, p_via text
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v record;
  o record;
  v_reason text;
  v_stop boolean := false;
begin
  if p_via is null or p_via not in ('strip', 'flag') then
    raise exception 'team_note: unknown via' using errcode = '22023';
  end if;
  perform _team_note_assert_member(p_tenant_id, p_actor);
  select * into v from _team_note_message_ctx(p_tenant_id, p_message_id);
  if not found then return jsonb_build_object('show', false, 'reason', 'not_found'); end if;
  if v.user_id is distinct from p_actor then
    raise exception 'team_note: not your chat' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('team_note:' || p_tenant_id::text || ':' || v.user_id::text, 0));
  select * into o from team_note_offers
   where tenant_id = p_tenant_id and message_id = p_message_id for update;
  if not found then return jsonb_build_object('show', false, 'reason', 'not_offered'); end if;
  if p_via = 'strip' and o.surface <> 'strip' and o.status in ('drafted', 'shown') then
    return jsonb_build_object('show', false, 'reason', 'flag_only');
  end if;
  if o.status = 'shown' then
    return jsonb_build_object('show', true, 'offer_stop',
      coalesce((v.meta -> 'team_note_draft' ->> 'offer_stop')::boolean, false),
      'signal', o.signal, 'source', o.source, 'offer_id', o.id, 'first', false,
      'via', o.shown_via);
  end if;
  if o.status <> 'drafted' then
    return jsonb_build_object('show', false, 'reason', o.status);
  end if;

  if p_via = 'strip' and o.source = 'run_end' then
    v_reason := _team_note_cap_reason_v2(p_tenant_id, v.user_id, v.thread_id,
                                         p_max_per_thread, p_thread_window_hours, p_max_per_day);
  elsif _team_note_suggestions_off(p_tenant_id, v.user_id) then
    v_reason := 'suggestions_off';
  end if;
  if v_reason is not null then
    update team_note_offers set status = 'suppressed', resolved_at = clock_timestamp()
     where tenant_id = p_tenant_id and id = o.id;
    perform _team_note_merge_meta(p_message_id, jsonb_build_object('team_note_state', 'suppressed'));
    return jsonb_build_object('show', false, 'reason', v_reason);
  end if;

  if p_via = 'strip' and p_stop_after > 0 then
    select count(*) = p_stop_after into v_stop from (
      select status from team_note_offers
       where tenant_id = p_tenant_id and user_id = v.user_id and status in ('sent', 'dismissed')
         and capped_as = 'run_end_strip'
       order by resolved_at desc
       limit p_stop_after
    ) last_n where last_n.status = 'dismissed';
  end if;

  update team_note_offers
     set status = 'shown', shown_at = coalesce(shown_at, now()), shown_via = coalesce(shown_via, p_via),
         capped_as = coalesce(capped_as,
           case when p_via = 'strip' and o.source = 'run_end' then 'run_end_strip' end)
   where tenant_id = p_tenant_id and id = o.id;
  update agent_thread_messages
     set meta = jsonb_set(coalesce(meta, '{}'::jsonb) || jsonb_build_object('team_note_state', 'shown'),
                          '{team_note_draft,offer_stop}', to_jsonb(v_stop), true)
   where id = p_message_id and tenant_id = p_tenant_id;
  return jsonb_build_object('show', true, 'offer_stop', v_stop,
    'signal', o.signal, 'source', o.source, 'offer_id', o.id, 'first', true, 'via', p_via);
end $$;
revoke all on function public.team_note_mark_shown_v2(uuid, uuid, uuid, integer, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.team_note_mark_shown_v2(uuid, uuid, uuid, integer, integer, integer, integer, text) to service_role;

create or replace function public.team_note_record_judgement_v2(
  p_tenant_id uuid, p_message_id uuid, p_source text, p_signals text[],
  p_verdict text, p_judge_signal text, p_surface text
) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v record;
begin
  select * into v from _team_note_message_ctx(p_tenant_id, p_message_id);
  if not found or v.sender_role <> 'assistant' then return false; end if;
  insert into team_note_judgements (tenant_id, message_id, run_id, agent_slug, source, signals,
                                    verdict, judge_signal, surface)
  values (p_tenant_id, p_message_id, v.run_id, v.agent_slug, p_source, coalesce(p_signals, '{}'),
          p_verdict, p_judge_signal, p_surface);
  return true;
end $$;
revoke all on function public.team_note_record_judgement_v2(uuid, uuid, text, text[], text, text, text) from public, anon, authenticated;
grant execute on function public.team_note_record_judgement_v2(uuid, uuid, text, text[], text, text, text) to service_role;

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

  select count(*) into v_backlog from (
    select 1 from team_reports where expires_at < now() limit 100000
  ) b;
  select coalesce(extract(epoch from now() - min(expires_at)), 0) into v_oldest
    from team_reports where expires_at < now();

  return jsonb_build_object(
    'deleted', v_reports + v_offers + v_claims + v_judgements,
    'backlog', v_backlog,
    'oldest_expired_seconds', v_oldest);
end $$;
revoke all on function public.purge_expired_team_notes_v2(integer, integer) from public, anon, authenticated;
grant execute on function public.purge_expired_team_notes_v2(integer, integer) to service_role;

create or replace function public.team_note_mark_shown(
  p_tenant_id uuid, p_actor uuid, p_message_id uuid,
  p_max_per_thread integer, p_thread_window_hours integer, p_max_per_day integer,
  p_stop_after integer
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  return team_note_mark_shown_v2(p_tenant_id, p_actor, p_message_id,
    p_max_per_thread, p_thread_window_hours, p_max_per_day, p_stop_after, 'strip');
end $$;
revoke all on function public.team_note_mark_shown(uuid, uuid, uuid, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.team_note_mark_shown(uuid, uuid, uuid, integer, integer, integer, integer) to service_role;

create or replace function public.team_note_offer(
  p_tenant_id uuid, p_message_id uuid, p_source text, p_signal text, p_signals text[],
  p_fingerprint text, p_note text
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  return team_note_offer_v2(p_tenant_id, p_message_id, p_source, p_signal, p_signals,
    p_fingerprint, p_note, 'flag', null);
end $$;
revoke all on function public.team_note_offer(uuid, uuid, text, text, text[], text, text) from public, anon, authenticated;
grant execute on function public.team_note_offer(uuid, uuid, text, text, text[], text, text) to service_role;

lock table public.team_note_offers in share row exclusive mode;

update public.team_note_offers
   set shown_via = coalesce(shown_via, 'strip'),
       capped_as = coalesce(capped_as, case when source = 'run_end' then 'run_end_strip' end)
 where shown_at is not null;

with retired as (
  update public.team_note_offers
     set status = 'suppressed', resolved_at = now()
   where status in ('drafted', 'shown')
  returning message_id, tenant_id
)
update public.agent_thread_messages m
   set meta = coalesce(m.meta, '{}'::jsonb) || jsonb_build_object('team_note_state', 'suppressed')
  from retired r
 where m.id = r.message_id and m.tenant_id = r.tenant_id;

commit;
