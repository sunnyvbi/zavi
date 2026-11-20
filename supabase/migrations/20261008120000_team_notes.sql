
begin;

set lock_timeout = '5s';

create table if not exists public.team_note_offers (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  thread_id    uuid not null references public.agent_threads(id) on delete cascade,
  message_id   uuid not null references public.agent_thread_messages(id) on delete cascade,
  run_id       uuid references public.agent_runs(id) on delete set null,
  agent_slug   text not null,
  source       text not null check (source in ('run_end', 'correction', 'rephrase', 'edit')),
  signal       text not null check (signal ~ '^[a-z_]{1,40}$'),
  signals      text[] not null default '{}',
  fingerprint  text not null check (fingerprint ~ '^[0-9a-f]{16}$'),
  status       text not null default 'drafted'
                 check (status in ('drafted', 'shown', 'suppressed', 'sent', 'dismissed', 'stopped')),
  drafted_at   timestamptz not null default now(),
  shown_at     timestamptz,
  opened_at    timestamptz,
  resolved_at  timestamptz,
  constraint team_note_offers_one_per_message unique (message_id)
);
create index if not exists team_note_offers_user_shown
  on public.team_note_offers (tenant_id, user_id, shown_at desc) where shown_at is not null;
create index if not exists team_note_offers_thread_shown
  on public.team_note_offers (tenant_id, thread_id, shown_at desc) where shown_at is not null;
create index if not exists team_note_offers_user_resolved
  on public.team_note_offers (tenant_id, user_id, resolved_at desc) where status in ('sent', 'dismissed');
create index if not exists team_note_offers_purge on public.team_note_offers (drafted_at);

alter table public.team_note_offers enable row level security;
revoke all on public.team_note_offers from public, anon, authenticated;
revoke all on public.team_note_offers from service_role;
grant select on public.team_note_offers to service_role;

create table if not exists public.team_note_judge_claims (
  message_id   uuid primary key references public.agent_thread_messages(id) on delete cascade,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  source       text not null check (source in ('run_end', 'correction', 'rephrase', 'edit')),
  signals      text[] not null default '{}',
  claimed_at   timestamptz not null default now()
);
create index if not exists team_note_judge_claims_purge on public.team_note_judge_claims (claimed_at);

alter table public.team_note_judge_claims enable row level security;
revoke all on public.team_note_judge_claims from public, anon, authenticated;
revoke all on public.team_note_judge_claims from service_role;
grant select on public.team_note_judge_claims to service_role;

create table if not exists public.team_reports (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  offer_id       uuid unique references public.team_note_offers(id) on delete set null,
  thread_id      uuid references public.agent_threads(id) on delete set null,
  message_id     uuid references public.agent_thread_messages(id) on delete set null,
  run_id         uuid references public.agent_runs(id) on delete set null,
  agent_slug     text not null,
  source         text not null,
  signal         text not null,
  signals        text[] not null default '{}',
  fingerprint    text not null,
  note           text not null check (length(note) between 1 and 1000),
  founder_extra  text check (founder_extra is null or length(founder_extra) <= 2000),
  note_edited    boolean not null default false,
  status         text not null default 'new' check (status in ('new', 'triaged', 'resolved')),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  constraint team_reports_retention_max check (expires_at <= created_at + interval '180 days')
);
create index if not exists team_reports_expires on public.team_reports (expires_at);

comment on table public.team_reports is
  'Report to Zavi team: a note the founder chose to send about one chat reply. '
  'CUSTOMER-DERIVED TEXT, treat as PII. Creator-only read; staff read server-side; '
  'never copied into memory. Deleted at expires_at (max 180 days).';

alter table public.team_reports enable row level security;
create policy team_reports_creator_select on public.team_reports
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.tenant_users tu
      where tu.user_id = (select auth.uid()) and tu.tenant_id = team_reports.tenant_id
    )
  );
create policy team_reports_active_tenant_restrict
  on public.team_reports as restrictive for select
  using (tenant_id = (select public.app_active_tenant()));

revoke all on public.team_reports from public, anon, authenticated;
grant select (id, tenant_id, user_id, thread_id, message_id, agent_slug, note,
              founder_extra, created_at)
  on public.team_reports to authenticated;
revoke all on public.team_reports from service_role;
grant select on public.team_reports to service_role;

create table if not exists public.team_note_prefs (
  user_id          uuid not null references auth.users(id) on delete cascade,
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  suggestions_off  boolean not null default false,
  updated_at       timestamptz not null default now(),
  primary key (user_id, tenant_id)
);
alter table public.team_note_prefs enable row level security;
create policy team_note_prefs_self_select on public.team_note_prefs
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.tenant_users tu
      where tu.user_id = (select auth.uid()) and tu.tenant_id = team_note_prefs.tenant_id
    )
  );
create policy team_note_prefs_active_tenant_restrict
  on public.team_note_prefs as restrictive for select
  using (tenant_id = (select public.app_active_tenant()));
revoke all on public.team_note_prefs from public, anon, authenticated;
grant select on public.team_note_prefs to authenticated;
revoke all on public.team_note_prefs from service_role;
grant select on public.team_note_prefs to service_role;

create or replace function public._team_note_assert_member(p_tenant_id uuid, p_actor uuid)
returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null or p_actor is null then
    raise exception 'team_note: tenant and actor are required' using errcode = '22023';
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor) then
    raise exception 'team_note: actor is not a member of this tenant' using errcode = '42501';
  end if;
end $$;
revoke all on function public._team_note_assert_member(uuid, uuid) from public, anon, authenticated;

create or replace function public._team_note_message_ctx(p_tenant_id uuid, p_message_id uuid)
returns table (thread_id uuid, user_id uuid, run_id uuid, agent_slug text, sender_role text, meta jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.thread_id, t.user_id, r.id,
         coalesce(r.agent_slug, t.agent_slug), m.sender_role, m.meta
    from agent_thread_messages m
    join agent_threads t on t.id = m.thread_id
    left join agent_runs r on r.id = m.agent_run_id and r.tenant_id = p_tenant_id
   where m.id = p_message_id and m.tenant_id = p_tenant_id and t.tenant_id = p_tenant_id
     and (m.agent_run_id is null or r.id is not null)
$$;
revoke all on function public._team_note_message_ctx(uuid, uuid) from public, anon, authenticated;

create or replace function public._team_note_cap_reason(
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
         and shown_at > now() - make_interval(hours => greatest(p_thread_window_hours, 1)))
     >= greatest(p_max_per_thread, 0) then
    return 'thread_cap';
  end if;
  if (select count(*) from team_note_offers
       where tenant_id = p_tenant_id and user_id = p_user_id and shown_at > now() - interval '24 hours')
     >= greatest(p_max_per_day, 0) then
    return 'daily_cap';
  end if;
  return null;
end $$;
revoke all on function public._team_note_cap_reason(uuid, uuid, uuid, integer, integer, integer) from public, anon, authenticated;

create or replace function public._team_note_merge_meta(p_message_id uuid, p_patch jsonb)
returns void
language sql volatile security definer set search_path = public, pg_temp as $$
  update agent_thread_messages set meta = coalesce(meta, '{}'::jsonb) || p_patch
   where id = p_message_id
$$;
revoke all on function public._team_note_merge_meta(uuid, jsonb) from public, anon, authenticated;

create or replace function public.team_note_can_offer(
  p_tenant_id uuid, p_message_id uuid,
  p_max_per_thread integer, p_thread_window_hours integer, p_max_per_day integer
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
  if exists (select 1 from team_note_judge_claims
              where tenant_id = p_tenant_id and message_id = p_message_id) then
    return 'already_judged';
  end if;
  return coalesce(
    _team_note_cap_reason(p_tenant_id, v.user_id, v.thread_id,
                          p_max_per_thread, p_thread_window_hours, p_max_per_day),
    'ok');
end $$;
revoke all on function public.team_note_can_offer(uuid, uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.team_note_can_offer(uuid, uuid, integer, integer, integer) to service_role;

create or replace function public.team_note_claim_judgement(
  p_tenant_id uuid, p_message_id uuid, p_source text, p_signals text[]
) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v record; v_claimed uuid;
begin
  select * into v from _team_note_message_ctx(p_tenant_id, p_message_id);
  if not found or v.sender_role <> 'assistant' then return false; end if;
  insert into team_note_judge_claims (message_id, tenant_id, source, signals)
  values (p_message_id, p_tenant_id, p_source, coalesce(p_signals, '{}'))
  on conflict (message_id) do nothing
  returning message_id into v_claimed;
  return v_claimed is not null;
end $$;
revoke all on function public.team_note_claim_judgement(uuid, uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.team_note_claim_judgement(uuid, uuid, text, text[]) to service_role;

create or replace function public.team_note_offer(
  p_tenant_id uuid, p_message_id uuid, p_source text, p_signal text, p_signals text[],
  p_fingerprint text, p_note text
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
  select * into v from _team_note_message_ctx(p_tenant_id, p_message_id);
  if not found or v.sender_role <> 'assistant' then
    return jsonb_build_object('offered', false, 'reason', 'not_found');
  end if;
  if exists (select 1 from team_note_prefs
              where tenant_id = p_tenant_id and user_id = v.user_id and suggestions_off) then
    return jsonb_build_object('offered', false, 'reason', 'suggestions_off');
  end if;

  insert into team_note_offers (tenant_id, user_id, thread_id, message_id, run_id, agent_slug,
                                source, signal, signals, fingerprint)
  values (p_tenant_id, v.user_id, v.thread_id, p_message_id, v.run_id, v.agent_slug,
          p_source, p_signal, coalesce(p_signals, '{}'), p_fingerprint)
  on conflict (message_id) do nothing
  returning id into v_offer_id;
  if v_offer_id is null then
    return jsonb_build_object('offered', false, 'reason', 'already_offered');
  end if;

  perform _team_note_merge_meta(p_message_id, jsonb_build_object(
    'team_note_draft', jsonb_build_object(
      'offer_id', v_offer_id, 'note', v_note, 'signal', p_signal, 'offer_stop', false),
    'team_note_state', 'drafted'));
  return jsonb_build_object('offered', true, 'offer_id', v_offer_id);
end $$;
revoke all on function public.team_note_offer(uuid, uuid, text, text, text[], text, text) from public, anon, authenticated;
grant execute on function public.team_note_offer(uuid, uuid, text, text, text[], text, text) to service_role;

create or replace function public.team_note_mark_shown(
  p_tenant_id uuid, p_actor uuid, p_message_id uuid,
  p_max_per_thread integer, p_thread_window_hours integer, p_max_per_day integer,
  p_stop_after integer
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v record;
  o record;
  v_reason text;
  v_stop boolean := false;
begin
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
  if o.status = 'shown' then
    return jsonb_build_object('show', true, 'offer_stop',
      coalesce((v.meta -> 'team_note_draft' ->> 'offer_stop')::boolean, false),
      'signal', o.signal, 'source', o.source, 'offer_id', o.id, 'first', false);
  end if;
  if o.status <> 'drafted' then
    return jsonb_build_object('show', false, 'reason', o.status);
  end if;

  v_reason := _team_note_cap_reason(p_tenant_id, v.user_id, v.thread_id,
                                    p_max_per_thread, p_thread_window_hours, p_max_per_day);
  if v_reason is not null then
    update team_note_offers set status = 'suppressed', resolved_at = clock_timestamp()
     where tenant_id = p_tenant_id and id = o.id;
    perform _team_note_merge_meta(p_message_id, jsonb_build_object('team_note_state', 'suppressed'));
    return jsonb_build_object('show', false, 'reason', v_reason);
  end if;

  if p_stop_after > 0 then
    select count(*) = p_stop_after into v_stop from (
      select status from team_note_offers
       where tenant_id = p_tenant_id and user_id = v.user_id and status in ('sent', 'dismissed')
       order by resolved_at desc
       limit p_stop_after
    ) last_n where last_n.status = 'dismissed';
  end if;

  update team_note_offers set status = 'shown', shown_at = now()
   where tenant_id = p_tenant_id and id = o.id;
  update agent_thread_messages
     set meta = jsonb_set(coalesce(meta, '{}'::jsonb) || jsonb_build_object('team_note_state', 'shown'),
                          '{team_note_draft,offer_stop}', to_jsonb(v_stop), true)
   where id = p_message_id and tenant_id = p_tenant_id;
  return jsonb_build_object('show', true, 'offer_stop', v_stop,
    'signal', o.signal, 'source', o.source, 'offer_id', o.id, 'first', true);
end $$;
revoke all on function public.team_note_mark_shown(uuid, uuid, uuid, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.team_note_mark_shown(uuid, uuid, uuid, integer, integer, integer, integer) to service_role;

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
  return jsonb_build_object('status', 'sent', 'report_id', v_report_id,
                            'signal', o.signal, 'source', o.source, 'first', true);
end $$;
revoke all on function public.team_note_send(uuid, uuid, uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.team_note_send(uuid, uuid, uuid, text, text, integer) to service_role;

create or replace function public.team_note_dismiss(
  p_tenant_id uuid, p_actor uuid, p_message_id uuid, p_stop boolean
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v record; o record; v_hit boolean;
begin
  perform _team_note_assert_member(p_tenant_id, p_actor);
  select * into v from _team_note_message_ctx(p_tenant_id, p_message_id);
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v.user_id is distinct from p_actor then
    raise exception 'team_note: not your chat' using errcode = '42501';
  end if;
  update team_note_offers
     set status = case when p_stop then 'stopped' else 'dismissed' end, resolved_at = clock_timestamp()
   where tenant_id = p_tenant_id and message_id = p_message_id and status = 'shown'
  returning * into o;
  v_hit := found;
  if p_stop then
    insert into team_note_prefs (user_id, tenant_id, suggestions_off, updated_at)
    values (p_actor, p_tenant_id, true, now())
    on conflict (user_id, tenant_id) do update set suggestions_off = true, updated_at = now();
  end if;
  if not v_hit then return jsonb_build_object('status', 'closed'); end if;
  perform _team_note_merge_meta(p_message_id, jsonb_build_object('team_note_state', 'dismissed'));
  return jsonb_build_object('status', 'dismissed', 'signal', o.signal, 'source', o.source);
end $$;
revoke all on function public.team_note_dismiss(uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.team_note_dismiss(uuid, uuid, uuid, boolean) to service_role;

create or replace function public.team_note_mark_opened(
  p_tenant_id uuid, p_actor uuid, p_message_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v record; o record;
begin
  perform _team_note_assert_member(p_tenant_id, p_actor);
  select * into v from _team_note_message_ctx(p_tenant_id, p_message_id);
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v.user_id is distinct from p_actor then
    raise exception 'team_note: not your chat' using errcode = '42501';
  end if;
  update team_note_offers set opened_at = coalesce(opened_at, now())
   where tenant_id = p_tenant_id and message_id = p_message_id
  returning * into o;
  if not found then return jsonb_build_object('status', 'not_offered'); end if;
  return jsonb_build_object('status', 'opened', 'signal', o.signal, 'source', o.source);
end $$;
revoke all on function public.team_note_mark_opened(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.team_note_mark_opened(uuid, uuid, uuid) to service_role;

create or replace function public.team_note_set_suggestions(
  p_tenant_id uuid, p_actor uuid, p_off boolean
) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform _team_note_assert_member(p_tenant_id, p_actor);
  insert into team_note_prefs (user_id, tenant_id, suggestions_off, updated_at)
  values (p_actor, p_tenant_id, coalesce(p_off, false), now())
  on conflict (user_id, tenant_id) do update
    set suggestions_off = excluded.suggestions_off, updated_at = now();
end $$;
revoke all on function public.team_note_set_suggestions(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.team_note_set_suggestions(uuid, uuid, boolean) to service_role;

create or replace function public.purge_expired_team_notes(p_limit integer, p_offer_days integer)
returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_lim integer := least(greatest(coalesce(p_limit, 1000), 1), 10000);
  v_days integer := greatest(coalesce(p_offer_days, 400), 1);
  v_reports integer;
  v_offers integer;
  v_claims integer;
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

  select count(*) into v_backlog from (
    select 1 from team_reports where expires_at < now() limit 100000
  ) b;
  select coalesce(extract(epoch from now() - min(expires_at)), 0) into v_oldest
    from team_reports where expires_at < now();

  return jsonb_build_object(
    'deleted', v_reports + v_offers + v_claims,
    'backlog', v_backlog,
    'oldest_expired_seconds', v_oldest);
end $$;
revoke all on function public.purge_expired_team_notes(integer, integer) from public, anon, authenticated;
grant execute on function public.purge_expired_team_notes(integer, integer) to service_role;

commit;
