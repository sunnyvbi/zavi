
begin;

create table if not exists public.email_planned_sends (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  route            text not null check (route in ('sendgrid', 'mailchimp', 'klaviyo', 'zavi_list')),
  list_id          text not null check (length(list_id) between 1 and 128),
  list_key         text not null,
  list_name        text not null check (length(list_name) between 1 and 300),
  planned_at       timestamptz not null,
  planned_tz       text not null,
  angle            text not null check (length(angle) between 1 and 120),
  why              text check (why is null or length(why) <= 300),
  source           text not null check (source in ('email_agent', 'growth_agent', 'founder')),
  created_by       uuid,
  request_key      text not null,
  status           text not null default 'planned'
                   check (status in ('planned', 'drafting', 'ready', 'scheduled', 'sending', 'sent', 'skipped', 'blocked', 'reconciling')),
  status_reason    text check (status_reason is null or length(status_reason) <= 300),
  content_version  int not null default 1,
  schedule_gen     int not null default 1,
  draft_attempts   int not null default 0,
  card_rail        text check (card_rail is null or card_rail in ('channel_actions', 'decisions')),
  card_id          uuid,
  vetoed_at        timestamptz,
  vetoed_by        uuid,
  sched_variant    int,
  sched_count      int,
  sched_by         uuid,
  sched_sha        text,
  sched_version    int,
  sched_card_id    uuid,
  sched_account    jsonb,
  sched_at         timestamptz,
  unattended       boolean not null default false,
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint email_planned_sends_tenant_id_id_key unique (tenant_id, id),
  constraint email_planned_sends_request_key unique (tenant_id, request_key),
  constraint email_planned_sends_sched_ck check (
    (sched_variant is null and sched_count is null and sched_by is null and sched_sha is null
       and sched_version is null and sched_card_id is null and sched_account is null and sched_at is null)
    or (sched_variant is not null and sched_count is not null and sched_by is not null and sched_sha is not null
       and sched_version is not null and sched_card_id is not null and sched_account is not null and sched_at is not null)),
  constraint email_planned_sends_card_ck check ((card_rail is null) = (card_id is null))
);
create index if not exists email_planned_sends_tenant_time on public.email_planned_sends (tenant_id, planned_at);
create index if not exists email_planned_sends_list on public.email_planned_sends (tenant_id, list_key, planned_at);
create unique index if not exists email_planned_sends_card on public.email_planned_sends (card_rail, card_id) where card_id is not null;
alter table public.email_planned_sends enable row level security;

create table if not exists public.email_plan_jobs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  item_id      uuid not null,
  kind         text not null check (kind in ('draft', 'deadline')),
  job_key      text not null,
  due_at       timestamptz not null,
  state        text not null default 'pending' check (state in ('pending', 'leased', 'done')),
  lease_token  uuid,
  lease_until  timestamptz,
  attempts     int not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  constraint email_plan_jobs_key unique (tenant_id, job_key),
  foreign key (tenant_id, item_id) references public.email_planned_sends (tenant_id, id) on delete cascade
);
create index if not exists email_plan_jobs_due on public.email_plan_jobs (due_at) where state <> 'done';
alter table public.email_plan_jobs enable row level security;

create table if not exists public.email_plan_outbox (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  item_id     uuid not null,
  event_id    text not null,
  event_name  text not null check (event_name in ('channel-action.approved', 'decision.approved')),
  event_data  jsonb not null,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  constraint email_plan_outbox_event unique (tenant_id, event_id),
  foreign key (tenant_id, item_id) references public.email_planned_sends (tenant_id, id) on delete cascade
);
create index if not exists email_plan_outbox_pending on public.email_plan_outbox (created_at) where sent_at is null;
alter table public.email_plan_outbox enable row level security;

create table if not exists public.email_plan_schedule (
  tenant_id     uuid primary key references public.tenants(id) on delete cascade,
  next_run_at   timestamptz not null,
  timezone      text not null,
  last_run_at   timestamptz,
  last_request  text,
  lease_token   uuid,
  lease_until   timestamptz,
  zone_checked_at timestamptz,
  updated_at    timestamptz not null default now()
);
alter table public.email_plan_schedule enable row level security;

create table if not exists public.email_send_reservations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  list_key        text not null,
  card_rail       text not null check (card_rail in ('channel_actions', 'decisions')),
  card_id         uuid not null,
  source          text,
  state           text not null default 'held' check (state in ('held', 'sent', 'released')),
  reserved_at     timestamptz not null default now(),
  settled_at      timestamptz,
  released_reason text,
  alerted_at      timestamptz,
  constraint email_send_reservations_card unique (card_rail, card_id)
);
create index if not exists email_send_reservations_list on public.email_send_reservations (tenant_id, list_key, reserved_at) where state <> 'released';
create index if not exists email_send_reservations_stuck on public.email_send_reservations (reserved_at) where state = 'held' and alerted_at is null;
alter table public.email_send_reservations enable row level security;

create table if not exists public.email_send_release_log (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  list_key    text not null,
  card_rail   text not null,
  card_id     uuid not null,
  item_id     uuid,
  released_by uuid not null,
  reason      text not null check (char_length(reason) between 1 and 500),
  released_at timestamptz not null default now()
);
create index if not exists email_send_release_log_tenant on public.email_send_release_log (tenant_id, released_at);
alter table public.email_send_release_log enable row level security;
revoke all on public.email_send_release_log from public, anon, authenticated;

revoke all on public.email_planned_sends, public.email_plan_jobs, public.email_plan_outbox,
              public.email_plan_schedule, public.email_send_reservations from public, anon, authenticated;

create or replace function public._email_list_lock(p_tenant_id uuid, p_key text) returns void
language sql volatile set search_path = public, pg_temp as $$
  select pg_advisory_xact_lock(hashtextextended('email_test_list:' || p_tenant_id::text || ':' || p_key, 0));
$$;
revoke all on function public._email_list_lock(uuid, text) from public, anon, authenticated;

create or replace function public._email_plan_list_key(p_route text, p_list_id text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case when p_route = 'zavi_list' then 'zavi_list:' || lower(trim(p_list_id)) else p_route || ':' || trim(p_list_id) end;
$$;
revoke all on function public._email_plan_list_key(text, text) from public, anon, authenticated;

create or replace function public._email_plan_role(p_tenant_id uuid, p_user_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select role from tenant_users where tenant_id = p_tenant_id and user_id = p_user_id;
$$;
revoke all on function public._email_plan_role(uuid, uuid) from public, anon, authenticated;

create or replace function public._email_list_sent_near(p_tenant_id uuid, p_key text, p_at timestamptz,
                                                         p_except_rail text default null, p_except_id uuid default null)
returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
  select max(case when r.state = 'held' then greatest(r.reserved_at, now()) else coalesce(r.settled_at, r.reserved_at) end)
    from email_send_reservations r
   where r.tenant_id = p_tenant_id and r.list_key = p_key
     and (r.state = 'held'
          or (r.state = 'sent' and coalesce(r.settled_at, r.reserved_at) > p_at - interval '7 days'))
     and not (r.card_rail is not distinct from p_except_rail and r.card_id is not distinct from p_except_id);
$$;

create or replace function public.email_list_sent_recently(p_tenant_id uuid, p_key text, p_except_rail text, p_except_id uuid)
returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
  select public._email_list_sent_near(p_tenant_id, p_key, now(), p_except_rail, p_except_id);
$$;
revoke all on function public.email_list_sent_recently(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.email_list_sent_recently(uuid, text, text, uuid) to service_role;
revoke all on function public._email_list_sent_near(uuid, text, timestamptz, text, uuid) from public, anon, authenticated;

create or replace function public._email_plan_account(p_class text, p_body jsonb) returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select case when p_class = 'bulk_outbound.send'
    then jsonb_build_object('list_id', p_body->'list_id', 'list_version_id', p_body->'list_version_id', 'from_address', p_body->'from_address')
    else jsonb_build_object('tool', p_body->'tool', 'credential', p_body->'credential', 'audience_id', p_body->'audience_id',
                            'connected_account_id', p_body->'connected_account_id', 'from_email', p_body->'from_email') end;
$$;
revoke all on function public._email_plan_account(text, jsonb) from public, anon, authenticated;

create or replace function public._email_plan_week(p_at timestamptz, p_tz text) returns date
language sql stable set search_path = public, pg_temp as $$
  select date_trunc('week', p_at at time zone p_tz)::date;
$$;
revoke all on function public._email_plan_week(timestamptz, text) from public, anon, authenticated;

create or replace function public._email_plan_reject_card(p_tenant_id uuid, p_rail text, p_id uuid, p_note text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int := 0;
begin
  if p_rail is null or p_id is null then return false; end if;
  if p_rail = 'channel_actions' then
    update channel_actions set status = 'rejected', status_at = now(), note = p_note
     where id = p_id and tenant_id = p_tenant_id and status in ('pending', 'snoozed') and exec_status is null and approved_by is null;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      insert into channel_action_events (tenant_id, action_id, event, actor_kind, note, event_key)
      values (p_tenant_id, p_id, 'rejected', 'system', p_note, 'plan:' || p_note || ':' || p_id::text)
      on conflict (action_id, event_key) do nothing;
    end if;
  else
    update decisions set status = 'rejected', rejected_at = now(), body = body || jsonb_build_object('rejected_reason', p_note)
     where id = p_id and tenant_id = p_tenant_id and status = 'proposed' and approved_by is null;
    get diagnostics v_n = row_count;
  end if;
  return v_n > 0;
end $$;
revoke all on function public._email_plan_reject_card(uuid, text, uuid, text) from public, anon, authenticated;

create or replace function public._email_plan_job(p_tenant_id uuid, p_item uuid, p_kind text, p_key text, p_due timestamptz) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update email_plan_jobs set state = 'done', lease_token = null, lease_until = null, last_error = 'superseded'
   where tenant_id = p_tenant_id and item_id = p_item and kind = p_kind and state <> 'done' and job_key <> p_key;
  insert into email_plan_jobs (tenant_id, item_id, kind, job_key, due_at)
  values (p_tenant_id, p_item, p_kind, p_key, p_due)
  on conflict (tenant_id, job_key) do update set due_at = excluded.due_at, state = 'pending', lease_token = null, lease_until = null
   where email_plan_jobs.state <> 'leased';
end $$;
revoke all on function public._email_plan_job(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;

create or replace function public._email_reserve(p_tenant_id uuid, p_key text, p_rail text, p_id uuid, p_source text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_key is null then return; end if;
  perform public._email_list_lock(p_tenant_id, p_key);
  insert into email_send_reservations (tenant_id, list_key, card_rail, card_id, source)
  values (p_tenant_id, p_key, p_rail, p_id, p_source)
  on conflict (card_rail, card_id) do update
     set state = 'held', reserved_at = now(), settled_at = null, released_reason = null, source = excluded.source,
         alerted_at = null
   where email_send_reservations.state = 'released';
end $$;
revoke all on function public._email_reserve(uuid, text, text, uuid, text) from public, anon, authenticated;

create or replace function public._email_reservation_settle(p_rail text, p_id uuid, p_state text, p_reason text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update email_send_reservations set state = p_state, settled_at = now(), released_reason = p_reason
   where card_rail = p_rail and card_id = p_id
     and (state = 'held' or (p_state = 'sent' and state = 'released'));
$$;
revoke all on function public._email_reservation_settle(text, uuid, text, text) from public, anon, authenticated;

create or replace function public._email_plan_settle(p_rail text, p_id uuid, p_to text, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_to = 'sending' then
    update email_planned_sends
       set status = 'sending', status_reason = null, vetoed_at = null, vetoed_by = null,
           sched_variant = null, sched_count = null, sched_by = null, sched_sha = null, sched_version = null,
           sched_card_id = null, sched_account = null, sched_at = null, updated_at = now()
     where card_rail = p_rail and card_id = p_id and status in ('ready', 'scheduled', 'skipped', 'blocked', 'sending', 'reconciling');
  elsif p_to = 'sent' then
    update email_planned_sends set status = 'sent', status_reason = null, sent_at = coalesce(sent_at, now()), updated_at = now()
     where card_rail = p_rail and card_id = p_id and status <> 'sent';
  elsif p_to = 'reconciling' then
    update email_planned_sends set status = 'reconciling', status_reason = p_reason, updated_at = now()
     where card_rail = p_rail and card_id = p_id and status in ('sending', 'reconciling');
  elsif p_to in ('skipped', 'blocked') then
    update email_planned_sends set status = p_to, status_reason = left(p_reason, 300), updated_at = now()
     where card_rail = p_rail and card_id = p_id and status in ('ready', 'scheduled', 'sending', 'reconciling');
  end if;
end $$;
revoke all on function public._email_plan_settle(text, uuid, text, text) from public, anon, authenticated;

create or replace function public._email_plan_blocking(p_code text) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_code in ('email_test_list', 'email_tool_not_connected', 'email_audience_missing',
                             'list_not_consented', 'list_archived', 'sending_domain_changed', 'email_sender_unknown'), false);
$$;
revoke all on function public._email_plan_blocking(text) from public, anon, authenticated;

create or replace function public.channel_actions_email_ledger() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key   text;
  v_code  text;
  v_stage text;
begin
  if new.exec_class is distinct from 'email_campaign.create_and_send' then return new; end if;
  v_key := public._email_test_list_key(new.exec_class, new.exec_payload);
  if new.exec_status is distinct from old.exec_status then
    if new.exec_status = 'queued' and old.exec_status is distinct from 'dispatching' then
      perform public._email_reserve(new.tenant_id, v_key, 'channel_actions', new.id, new.approved_by_source);
      perform public._email_plan_settle('channel_actions', new.id, 'sending', null);
    elsif new.exec_status = 'executed' then
      perform public._email_reservation_settle('channel_actions', new.id, 'sent', null);
      perform public._email_plan_settle('channel_actions', new.id, 'sent', null);
    end if;
  end if;
  if new.exec_status = 'failed'
     and (new.exec_status is distinct from old.exec_status or new.exec_result is distinct from old.exec_result) then
    v_code := new.exec_result->>'code';
    v_stage := new.exec_progress->>'stage';
    if v_code = 'not_sent_confirmed' then
      null;
    elsif coalesce((new.exec_result->>'audience_mismatch')::boolean, false) then
      perform public._email_plan_settle('channel_actions', new.id, 'blocked', 'audience_mismatch');
    elsif v_code = 'exec_partial' and coalesce((new.exec_result->>'not_sent')::boolean, false) then
      perform public._email_reservation_settle('channel_actions', new.id, 'released', 'not_sent');
      perform public._email_plan_settle('channel_actions', new.id, 'skipped', coalesce(left(new.exec_result->>'error', 250), 'not_sent'));
    elsif v_code in ('exec_outcome_unknown', 'exec_partial') or v_stage in ('send_requested', 'sent')
          or new.exec_result->>'bucket' = 'partial_risk' then
      perform public._email_plan_settle('channel_actions', new.id, 'reconciling', 'outcome_unknown');
    else
      perform public._email_reservation_settle('channel_actions', new.id, 'released', coalesce(v_code, 'failed'));
      perform public._email_plan_settle('channel_actions', new.id,
        case when public._email_plan_blocking(v_code) then 'blocked' else 'skipped' end,
        case when coalesce((new.exec_result->>'held_for_founder')::boolean, false) then 'held: ' else '' end
          || coalesce(left(new.exec_result->>'error', 250), v_code, 'failed'));
    end if;
  end if;
  if new.status = 'rejected' and old.status is distinct from 'rejected' then
    perform public._email_plan_settle('channel_actions', new.id, 'skipped', 'card_rejected');
  end if;
  return new;
end $$;
revoke all on function public.channel_actions_email_ledger() from public, anon, authenticated;
drop trigger if exists channel_actions_email_ledger on public.channel_actions;
create trigger channel_actions_email_ledger after update on public.channel_actions
  for each row
  when (new.exec_class = 'email_campaign.create_and_send'
        and (old.exec_status is distinct from new.exec_status or old.status is distinct from new.status
             or old.exec_result is distinct from new.exec_result))
  execute function public.channel_actions_email_ledger();

create or replace function public._email_decision_send_started(p_tenant_id uuid, p_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from email_bulk_sends b where b.decision_id = p_id and b.tenant_id = p_tenant_id
                   and b.total is distinct from 0)
      or exists (select 1 from email_send_refs s where s.rail = 'decisions' and s.card_id = p_id and s.tenant_id = p_tenant_id);
$$;
revoke all on function public._email_decision_send_started(uuid, uuid) from public, anon, authenticated;

create or replace function public.decisions_email_ledger() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key text;
begin
  if new.decision_class is null or new.decision_class not in ('email_campaign.create_and_send', 'bulk_outbound.send') then
    return new;
  end if;
  if new.status is not distinct from old.status then return new; end if;
  if new.status = 'dispatch_failed' and new.dispatch_error is not distinct from 'not_sent_confirmed' then return new; end if;
  v_key := public._email_test_list_key(new.decision_class, new.body);
  if new.status = 'approved' and new.approved_by is not null then
    perform public._email_reserve(new.tenant_id, v_key, 'decisions', new.id, new.approved_by_source);
    perform public._email_plan_settle('decisions', new.id, 'sending', null);
  elsif new.status = 'acted' then
    perform public._email_reservation_settle('decisions', new.id, 'sent', null);
    perform public._email_plan_settle('decisions', new.id, 'sent', null);
  elsif new.status = 'dispatch_failed'
        or (new.status = 'proposed' and old.status = 'dispatching' and new.approved_by is null) then
    if public._email_decision_send_started(new.tenant_id, new.id) then
      perform public._email_plan_settle('decisions', new.id, 'reconciling', 'may_have_sent');
    elsif new.status = 'dispatch_failed' then
      perform public._email_reservation_settle('decisions', new.id, 'released', 'dispatch_failed');
      perform public._email_plan_settle('decisions', new.id, 'skipped', coalesce(left(new.dispatch_error, 250), 'dispatch_failed'));
    else
      perform public._email_reservation_settle('decisions', new.id, 'released', 'held_for_founder');
      perform public._email_plan_settle('decisions', new.id, 'skipped', 'held: ' || coalesce(left(new.dispatch_error, 240), 'held'));
    end if;
  elsif new.status = 'rejected' then
    perform public._email_plan_settle('decisions', new.id, 'skipped', 'card_rejected');
  end if;
  return new;
end $$;
revoke all on function public.decisions_email_ledger() from public, anon, authenticated;
drop trigger if exists decisions_email_ledger on public.decisions;
create trigger decisions_email_ledger after update on public.decisions
  for each row
  when (new.decision_class in ('email_campaign.create_and_send', 'bulk_outbound.send')
        and old.status is distinct from new.status)
  execute function public.decisions_email_ledger();

insert into email_send_reservations (tenant_id, list_key, card_rail, card_id, source, state, reserved_at, settled_at)
select ca.tenant_id, public._email_test_list_key(ca.exec_class, ca.exec_payload), 'channel_actions', ca.id, ca.approved_by_source,
       case when ca.exec_status = 'executed' then 'sent' else 'held' end,
       coalesce(ca.exec_claimed_at, ca.executed_at, now()),
       case when ca.exec_status = 'executed' then ca.executed_at end
  from channel_actions ca
 where ca.exec_class = 'email_campaign.create_and_send'
   and public._email_test_list_key(ca.exec_class, ca.exec_payload) is not null
   and (ca.exec_status in ('queued', 'dispatching')
        or (ca.exec_status = 'executed' and ca.executed_at > now() - interval '7 days')
        or (ca.exec_status = 'failed'
            and not coalesce(ca.exec_result->>'code' = 'exec_partial'
                             and (ca.exec_result->>'not_sent')::boolean is true
                             and (ca.exec_result->>'audience_mismatch')::boolean is not true, false)
            and (coalesce(ca.exec_progress->>'stage' in ('send_requested', 'sent'), false)
                 or coalesce(ca.exec_result->>'code' in ('exec_outcome_unknown', 'exec_partial'), false)
                 or (ca.exec_result->>'audience_mismatch')::boolean is true
                 or coalesce(ca.exec_result->>'bucket' = 'partial_risk', false))))
on conflict (card_rail, card_id) do nothing;

insert into email_send_reservations (tenant_id, list_key, card_rail, card_id, source, state, reserved_at, settled_at)
select d.tenant_id, public._email_test_list_key(d.decision_class, d.body), 'decisions', d.id, d.approved_by_source,
       case when d.status = 'acted' then 'sent' else 'held' end,
       coalesce(d.dispatched_at, d.approved_at, now()),
       case when d.status = 'acted' then d.dispatched_at end
  from decisions d
 where d.decision_class in ('email_campaign.create_and_send', 'bulk_outbound.send')
   and public._email_test_list_key(d.decision_class, d.body) is not null
   and ((d.status in ('approved', 'dispatching') and d.approved_by is not null)
        or (d.status = 'acted' and d.dispatched_at > now() - interval '7 days')
        or (d.status = 'proposed' and d.approved_by is not null)
        or (d.status in ('dispatch_failed', 'proposed', 'rejected') and public._email_decision_send_started(d.tenant_id, d.id)))
on conflict (card_rail, card_id) do nothing;

create or replace function public._email_hold_state(p_tenant_id uuid, p_rail text, p_id uuid)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case p_rail
    when 'channel_actions' then coalesce((
      select case
        when (ca.exec_result->>'audience_mismatch')::boolean is true then 'mail_left'
        when ca.exec_status = 'failed'
             and (ca.exec_result->>'code' is distinct from 'exec_outcome_unknown'
                  or (ca.exec_result->>'reconciled')::boolean is true
                  or coalesce(ca.exec_claimed_at < now() - interval '2 hours', true)) then 'unresolved'
        when ca.exec_status = 'dispatching' and ca.exec_claimed_at < now() - interval '2 hours' then 'unresolved'
        else 'settling' end
        from channel_actions ca where ca.id = p_id and ca.tenant_id = p_tenant_id), 'unresolved')
    when 'decisions' then coalesce((
      select case
        when exists (select 1 from email_bulk_sends b where b.decision_id = d.id and b.tenant_id = d.tenant_id
                       and b.total is distinct from 0) then 'zavi_sending'
        when d.status in ('dispatch_failed', 'rejected') then 'unresolved'
        when d.status = 'proposed' and d.approved_by is null then 'unresolved'
        when d.status = 'proposed' and coalesce(d.dispatched_at < now() - interval '2 hours', false) then 'unresolved'
        when d.status = 'dispatching' and d.dispatched_at < now() - interval '2 hours' then 'unresolved'
        else 'settling' end
        from decisions d where d.id = p_id and d.tenant_id = p_tenant_id), 'unresolved')
    else 'settling' end;
$$;
revoke all on function public._email_hold_state(uuid, text, uuid) from public, anon, authenticated;

create or replace function public._email_hold_unresolved(p_tenant_id uuid, p_rail text, p_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public._email_hold_state(p_tenant_id, p_rail, p_id) = 'unresolved';
$$;
revoke all on function public._email_hold_unresolved(uuid, text, uuid) from public, anon, authenticated;

create or replace function public.confirm_email_not_sent(
  p_tenant_id uuid, p_actor_user_id uuid, p_rail text, p_card_id uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_key    text;
  v_res    email_send_reservations%rowtype;
  v_item   uuid;
  v_state  text;
  v_flag   text;
begin
  if p_tenant_id is null or p_actor_user_id is null or p_card_id is null
     or p_rail is null or p_rail not in ('channel_actions', 'decisions')
     or v_reason is null or char_length(v_reason) > 500 then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  if coalesce(public._email_plan_role(p_tenant_id, p_actor_user_id), '') not in ('owner', 'admin') then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  select list_key into v_key from email_send_reservations
   where tenant_id = p_tenant_id and card_rail = p_rail and card_id = p_card_id;
  if v_key is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  perform public._email_list_lock(p_tenant_id, v_key);
  select id into v_item from email_planned_sends
   where tenant_id = p_tenant_id and card_rail = p_rail and card_id = p_card_id for update;
  begin
    if p_rail = 'channel_actions' then
      perform 1 from channel_actions where id = p_card_id and tenant_id = p_tenant_id for update nowait;
    else
      perform 1 from decisions where id = p_card_id and tenant_id = p_tenant_id for update nowait;
    end if;
  exception when lock_not_available then
    return jsonb_build_object('ok', false, 'code', 'still_sending');
  end;
  select * into v_res from email_send_reservations
   where tenant_id = p_tenant_id and card_rail = p_rail and card_id = p_card_id for update;
  if v_res.state is distinct from 'held' then
    return jsonb_build_object('ok', true, 'changed', false, 'state', v_res.state);
  end if;
  v_state := public._email_hold_state(p_tenant_id, p_rail, p_card_id);
  if v_state <> 'unresolved' then
    return jsonb_build_object('ok', false, 'code', case v_state when 'settling' then 'still_sending' else v_state end);
  end if;
  v_flag := coalesce(current_setting('zavi.email_card_approve', true), '');
  perform set_config('zavi.email_card_approve', 'on', true);
  if p_rail = 'channel_actions' then
    update channel_actions
       set exec_status = 'failed',
           exec_result = jsonb_build_object('code', 'not_sent_confirmed',
                                            'error', 'You checked your email tool: it was not sent.',
                                            'prior_code', exec_result->>'code')
     where id = p_card_id and tenant_id = p_tenant_id;
  else
    update decisions set status = 'dispatch_failed', dispatch_error = 'not_sent_confirmed'
     where id = p_card_id and tenant_id = p_tenant_id and status in ('proposed', 'approved', 'dispatching');
  end if;
  perform set_config('zavi.email_card_approve', v_flag, true);
  update email_send_reservations
     set state = 'released', settled_at = now(), released_reason = 'founder_not_sent'
   where id = v_res.id;
  insert into email_send_release_log (tenant_id, list_key, card_rail, card_id, item_id, released_by, reason)
  values (p_tenant_id, v_key, p_rail, p_card_id, v_item, p_actor_user_id, v_reason);
  perform public._email_plan_settle(p_rail, p_card_id, 'skipped', 'not_sent_confirmed');
  return jsonb_build_object('ok', true, 'changed', true);
end $$;
revoke all on function public.confirm_email_not_sent(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_email_not_sent(uuid, uuid, text, uuid, text) to service_role;

create or replace function public.alert_stuck_email_holds(p_limit int) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select * from email_send_reservations
     where state = 'held' and alerted_at is null and reserved_at < now() - interval '24 hours'
     order by reserved_at
     limit greatest(1, least(coalesce(p_limit, 50), 200))
     for update skip locked
  loop
    perform public.enqueue_ops_alert(
      'email_hold_stuck:' || r.card_rail || ':' || r.card_id || ':' || floor(extract(epoch from r.reserved_at))::bigint,
      'email_send_reservations',
      'email_send_hold_stuck',
      r.tenant_id,
      'email send held over 24h rail=' || r.card_rail || ' card=' || r.card_id
        || ' since=' || to_char(r.reserved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"')
        || ' source=' || coalesce(r.source, 'none')
        || ' state=' || public._email_hold_state(r.tenant_id, r.card_rail, r.card_id)
        || '; the list gets no other Zavi send until it settles or an owner confirms it was not sent');
    update email_send_reservations set alerted_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.alert_stuck_email_holds(int) from public, anon, authenticated;
grant execute on function public.alert_stuck_email_holds(int) to service_role;

create or replace function public._email_card_retryable(p_result jsonb) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_result->>'bucket', '') not in ('blocked_on_us', 'partial_risk')
     and coalesce(p_result->>'code', '') not in ('exec_partial', 'exec_outcome_unknown', 'not_sent_confirmed')
$$;
revoke all on function public._email_card_retryable(jsonb) from public, anon, authenticated;

create or replace function public.plan_email_send(
  p_tenant_id   uuid,
  p_actor       uuid,
  p_source      text,
  p_route       text,
  p_list_id     text,
  p_list_name   text,
  p_planned_at  timestamptz,
  p_tz          text,
  p_angle       text,
  p_why         text,
  p_request_key text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key   text;
  v_row   email_planned_sends%rowtype;
  v_week  int;
  v_near  timestamptz;
  v_angle text := nullif(trim(coalesce(p_angle, '')), '');
  v_why   text := nullif(trim(coalesce(p_why, '')), '');
  v_req   text := left(nullif(trim(coalesce(p_request_key, '')), ''), 200);
begin
  if p_tenant_id is null or p_route not in ('sendgrid', 'mailchimp', 'klaviyo', 'zavi_list')
     or nullif(trim(coalesce(p_list_id, '')), '') is null or p_planned_at is null or v_req is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  if p_source not in ('email_agent', 'growth_agent', 'founder') then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  if p_route = 'zavi_list' and p_list_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return jsonb_build_object('ok', false, 'code', 'list_not_found');
  end if;
  if p_route <> 'zavi_list' and p_list_id !~ '^[A-Za-z0-9_-]{1,128}$' then
    return jsonb_build_object('ok', false, 'code', 'list_not_found');
  end if;
  if p_source = 'founder' then
    if coalesce(public._email_plan_role(p_tenant_id, p_actor), '') not in ('owner', 'admin') then
      return jsonb_build_object('ok', false, 'code', 'not_authorized');
    end if;
  elsif p_actor is not null then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  if v_angle is null or length(v_angle) > 120 or (v_why is not null and length(v_why) > 300)
     or nullif(trim(coalesce(p_list_name, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  if p_tz is null or not exists (select 1 from pg_timezone_names where name = p_tz) then
    return jsonb_build_object('ok', false, 'code', 'bad_timezone');
  end if;
  select * into v_row from email_planned_sends where tenant_id = p_tenant_id and request_key = v_req;
  if found then return jsonb_build_object('ok', true, 'replayed', true, 'id', v_row.id); end if;

  if p_planned_at < now() + interval '26 hours' then
    return jsonb_build_object('ok', false, 'code', 'too_soon');
  end if;
  if p_planned_at > now() + interval '14 days' then
    return jsonb_build_object('ok', false, 'code', 'too_far');
  end if;
  if p_route = 'zavi_list' and not exists (
       select 1 from email_lists where id = p_list_id::uuid and tenant_id = p_tenant_id and archived_at is null) then
    return jsonb_build_object('ok', false, 'code', 'list_not_found');
  end if;

  v_key := public._email_plan_list_key(p_route, p_list_id);
  if public._email_test_list_marked(p_tenant_id, v_key) then
    return jsonb_build_object('ok', false, 'code', 'test_list');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('email_plan:' || p_tenant_id::text, 0));

  select count(*) into v_week from email_planned_sends
   where tenant_id = p_tenant_id
     and public._email_plan_week(planned_at, planned_tz) = public._email_plan_week(p_planned_at, p_tz);
  if v_week >= 3 then
    return jsonb_build_object('ok', false, 'code', 'week_full');
  end if;
  if exists (select 1 from email_planned_sends
              where tenant_id = p_tenant_id and list_key = v_key and status not in ('skipped', 'blocked')
                and planned_at > p_planned_at - interval '7 days' and planned_at < p_planned_at + interval '7 days') then
    return jsonb_build_object('ok', false, 'code', 'list_spacing');
  end if;
  v_near := public._email_list_sent_near(p_tenant_id, v_key, p_planned_at);
  if v_near is not null then
    return jsonb_build_object('ok', false, 'code', 'list_sent_recently', 'last_send_at', v_near);
  end if;

  insert into email_planned_sends (tenant_id, route, list_id, list_key, list_name, planned_at, planned_tz,
                                   angle, why, source, created_by, request_key)
  values (p_tenant_id, p_route, trim(p_list_id), v_key, left(trim(p_list_name), 300), p_planned_at, p_tz,
          v_angle, v_why, p_source, p_actor, v_req)
  returning * into v_row;
  perform public._email_plan_job(p_tenant_id, v_row.id, 'draft', 'draft:' || v_row.id || ':v1:g1', p_planned_at - interval '24 hours');
  perform public._email_plan_job(p_tenant_id, v_row.id, 'deadline', 'deadline:' || v_row.id || ':g1', p_planned_at);
  return jsonb_build_object('ok', true, 'replayed', false, 'id', v_row.id);
end $$;
revoke all on function public.plan_email_send(uuid, uuid, text, text, text, text, timestamptz, text, text, text, text) from public, anon, authenticated;
grant execute on function public.plan_email_send(uuid, uuid, text, text, text, text, timestamptz, text, text, text, text) to service_role;

create or replace function public._email_plan_lock_item(p_tenant_id uuid, p_id uuid, p_actor uuid,
  out o_row public.email_planned_sends, out o_code text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_key text;
begin
  o_code := null;
  select list_key into v_key from email_planned_sends where id = p_id and tenant_id = p_tenant_id;
  if v_key is null then o_code := 'not_found'; return; end if;
  if p_actor is not null and coalesce(public._email_plan_role(p_tenant_id, p_actor), '') not in ('owner', 'admin') then
    o_code := 'not_authorized'; return;
  end if;
  perform public._email_list_lock(p_tenant_id, v_key);
  select * into o_row from email_planned_sends where id = p_id and tenant_id = p_tenant_id for update;
end $$;
revoke all on function public._email_plan_lock_item(uuid, uuid, uuid) from public, anon, authenticated;

drop function if exists public.move_email_planned_send(uuid, uuid, uuid, timestamptz, int);
create or replace function public.move_email_planned_send(
  p_tenant_id uuid, p_actor uuid, p_id uuid, p_planned_at timestamptz, p_expected_gen int, p_tz text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  l record;
  v_row email_planned_sends%rowtype;
  v_week int;
  v_near timestamptz;
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
    perform public._email_plan_job(p_tenant_id, p_id, 'draft', 'draft:' || p_id || ':v' || v_row.content_version || ':g' || v_row.schedule_gen,
                                   greatest(now(), p_planned_at - interval '24 hours'));
  end if;
  return jsonb_build_object('ok', true, 'schedule_gen', v_row.schedule_gen, 'planned_at', v_row.planned_at);
end $$;
revoke all on function public.move_email_planned_send(uuid, uuid, uuid, timestamptz, int, text) from public, anon, authenticated;
grant execute on function public.move_email_planned_send(uuid, uuid, uuid, timestamptz, int, text) to service_role;

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
  update email_planned_sends
     set angle = v_angle, content_version = content_version + 1, schedule_gen = schedule_gen + 1, status = 'planned', status_reason = null,
         card_rail = null, card_id = null, draft_attempts = 0, vetoed_at = null, vetoed_by = null,
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

create or replace function public.skip_email_planned_send(p_tenant_id uuid, p_actor uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  l record;
begin
  if p_actor is null then return jsonb_build_object('ok', false, 'code', 'bad_request'); end if;
  select * into l from public._email_plan_lock_item(p_tenant_id, p_id, p_actor);
  if l.o_code is not null then return jsonb_build_object('ok', false, 'code', l.o_code); end if;
  if (l.o_row).status = 'skipped' then return jsonb_build_object('ok', true, 'changed', false); end if;
  if (l.o_row).status not in ('planned', 'drafting', 'ready', 'scheduled', 'blocked') then
    return jsonb_build_object('ok', false, 'code', 'not_skippable', 'status', (l.o_row).status);
  end if;
  update email_planned_sends
     set status = 'skipped', status_reason = 'skipped_by_founder', card_rail = null, card_id = null,
         sched_variant = null, sched_count = null, sched_by = null, sched_sha = null, sched_version = null,
         sched_card_id = null, sched_account = null, sched_at = null, updated_at = now()
   where id = p_id;
  perform public._email_plan_reject_card(p_tenant_id, (l.o_row).card_rail, (l.o_row).card_id, 'plan_skipped');
  update email_plan_jobs set state = 'done', last_error = 'skipped' where tenant_id = p_tenant_id and item_id = p_id and state = 'pending';
  return jsonb_build_object('ok', true, 'changed', true);
end $$;
revoke all on function public.skip_email_planned_send(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.skip_email_planned_send(uuid, uuid, uuid) to service_role;

create or replace function public.draft_email_planned_now(p_tenant_id uuid, p_actor uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare l record;
begin
  if p_actor is null then return jsonb_build_object('ok', false, 'code', 'bad_request'); end if;
  select * into l from public._email_plan_lock_item(p_tenant_id, p_id, p_actor);
  if l.o_code is not null then return jsonb_build_object('ok', false, 'code', l.o_code); end if;
  if (l.o_row).status <> 'planned' or (l.o_row).planned_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'not_draftable', 'status', (l.o_row).status);
  end if;
  perform public._email_plan_job(p_tenant_id, p_id, 'draft',
    'draft:' || p_id || ':v' || (l.o_row).content_version || ':g' || (l.o_row).schedule_gen || ':now', now());
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.draft_email_planned_now(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.draft_email_planned_now(uuid, uuid, uuid) to service_role;

create or replace function public.schedule_email_planned_send(
  p_tenant_id uuid, p_actor uuid, p_id uuid, p_variant int, p_count int
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  l    record;
  c    record;
  v_sha text;
begin
  if p_actor is null then return jsonb_build_object('ok', false, 'code', 'bad_request'); end if;
  select * into l from public._email_plan_lock_item(p_tenant_id, p_id, p_actor);
  if l.o_code is not null then return jsonb_build_object('ok', false, 'code', l.o_code); end if;
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
         sched_account = public._email_plan_account(c.o_class, c.o_body), sched_at = now(), updated_at = now()
   where id = p_id;
  return jsonb_build_object('ok', true, 'planned_at', (l.o_row).planned_at);
end $$;
revoke all on function public.schedule_email_planned_send(uuid, uuid, uuid, int, int) from public, anon, authenticated;
grant execute on function public.schedule_email_planned_send(uuid, uuid, uuid, int, int) to service_role;

create or replace function public.withdraw_email_planned_send(p_tenant_id uuid, p_actor uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare l record;
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
         sched_card_id = null, sched_account = null, sched_at = null, updated_at = now()
   where id = p_id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.withdraw_email_planned_send(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.withdraw_email_planned_send(uuid, uuid, uuid) to service_role;

drop function if exists public.begin_email_plan_draft(uuid, uuid);
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

create or replace function public.email_plan_run_context(p_tenant_id uuid, p_run_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_payload jsonb;
  v_plan    jsonb;
  v_brief   boolean;
  v_row     email_planned_sends%rowtype;
begin
  select payload into v_payload from agent_runs where id = p_run_id and tenant_id = p_tenant_id;
  if not found then return jsonb_build_object('found', false); end if;
  v_brief := coalesce(jsonb_typeof(v_payload) = 'object' and v_payload ? 'cgo_brief', false);
  v_plan := case when jsonb_typeof(v_payload) = 'object' then v_payload->'email_plan' end;
  if v_plan is null or jsonb_typeof(v_plan) <> 'object' then
    return jsonb_build_object('found', true, 'mode', null, 'briefed', v_brief);
  end if;
  if v_plan->>'mode' = 'weekly_plan' then
    return jsonb_build_object('found', true, 'mode', 'weekly_plan', 'briefed', v_brief);
  end if;
  if v_plan->>'mode' is distinct from 'planned_draft' then
    return jsonb_build_object('found', true, 'mode', null, 'briefed', v_brief);
  end if;
  select * into v_row from email_planned_sends where tenant_id = p_tenant_id and id = (v_plan->>'item_id')::uuid;
  if not found then return jsonb_build_object('found', true, 'mode', 'planned_draft', 'briefed', v_brief, 'stale', true); end if;
  return jsonb_build_object('found', true, 'mode', 'planned_draft', 'briefed', v_brief, 'item_id', v_row.id, 'version', (v_plan->>'version')::int,
    'stale', v_row.content_version is distinct from (v_plan->>'version')::int or v_row.status <> 'drafting' or v_row.card_id is not null,
    'route', v_row.route, 'list_id', v_row.list_id, 'list_name', v_row.list_name, 'planned_at', v_row.planned_at, 'angle', v_row.angle);
exception when invalid_text_representation then
  return jsonb_build_object('found', true, 'mode', 'planned_draft', 'briefed', false, 'stale', true);
end $$;
revoke all on function public.email_plan_run_context(uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_plan_run_context(uuid, uuid) to service_role;

create or replace function public.attach_email_planned_card(
  p_tenant_id uuid, p_id uuid, p_version int, p_run_id uuid, p_rail text, p_card_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key  text;
  v_row  email_planned_sends%rowtype;
  v_plan jsonb;
  c      record;
begin
  if p_rail not in ('channel_actions', 'decisions') or p_card_id is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  select payload->'email_plan' into v_plan from agent_runs where id = p_run_id and tenant_id = p_tenant_id;
  if v_plan is null or v_plan->>'mode' is distinct from 'planned_draft' or v_plan->>'item_id' is distinct from p_id::text
     or (v_plan->>'version')::int is distinct from p_version then
    return jsonb_build_object('ok', false, 'code', 'not_this_run');
  end if;
  select list_key into v_key from email_planned_sends where id = p_id and tenant_id = p_tenant_id;
  if v_key is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  perform public._email_list_lock(p_tenant_id, v_key);
  select * into v_row from email_planned_sends where id = p_id and tenant_id = p_tenant_id for update;
  if v_row.card_rail is not distinct from p_rail and v_row.card_id is not distinct from p_card_id
     and v_row.content_version = p_version then
    return jsonb_build_object('ok', true, 'replayed', true);
  end if;
  if v_row.content_version is distinct from p_version or v_row.status <> 'drafting' or v_row.card_id is not null then
    return jsonb_build_object('ok', false, 'code', 'plan_changed');
  end if;
  select * into c from public._email_card(p_tenant_id, p_rail, p_card_id, false);
  if not coalesce(c.o_found, false) or not c.o_open then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if public._email_test_list_key(c.o_class, c.o_body) is distinct from v_key then
    return jsonb_build_object('ok', false, 'code', 'wrong_list');
  end if;
  if (c.o_body->>'planned_send_id') is distinct from p_id::text or (c.o_body->>'plan_version')::int is distinct from p_version then
    return jsonb_build_object('ok', false, 'code', 'not_this_plan');
  end if;
  update email_planned_sends set card_rail = p_rail, card_id = p_card_id, status = 'ready', status_reason = null, updated_at = now()
   where id = p_id;
  return jsonb_build_object('ok', true);
exception when invalid_text_representation then
  return jsonb_build_object('ok', false, 'code', 'not_this_run');
end $$;
revoke all on function public.attach_email_planned_card(uuid, uuid, int, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.attach_email_planned_card(uuid, uuid, int, uuid, text, uuid) to service_role;

create or replace function public.email_plan_deadline_state(p_tenant_id uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row email_planned_sends%rowtype;
  c record;
begin
  select * into v_row from email_planned_sends where id = p_id and tenant_id = p_tenant_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if v_row.card_id is null then return jsonb_build_object('ok', true, 'status', v_row.status, 'card', null, 'schedule_gen', v_row.schedule_gen); end if;
  select * into c from public._email_card(p_tenant_id, v_row.card_rail, v_row.card_id, false);
  return jsonb_build_object('ok', true, 'status', v_row.status, 'schedule_gen', v_row.schedule_gen,
    'needs_unattended', v_row.status = 'ready' and v_row.vetoed_at is null and coalesce(c.o_open, false),
    'card', jsonb_build_object('rail', v_row.card_rail, 'id', v_row.card_id, 'class', c.o_class, 'body', c.o_body));
end $$;
revoke all on function public.email_plan_deadline_state(uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_plan_deadline_state(uuid, uuid) to service_role;

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
      v_skip := 'not_approved_in_time';
    else
      v_count := (p_unattended->>'count')::int;
      select tu.user_id into v_owner from tenant_users tu
       where tu.tenant_id = p_tenant_id and tu.role = 'owner' order by tu.user_id limit 1;
      select * into c from public._email_card(p_tenant_id, v_row.card_rail, v_row.card_id, true);
      if v_count is null or v_count < 1 or v_count > 1000 then
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

create or replace function public.email_plan_autopilot_source_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.approved_by_source = 'plan_autopilot'
     and (tg_op = 'INSERT' or old.approved_by_source is distinct from 'plan_autopilot')
     and coalesce(current_setting('zavi.email_plan_fire', true), '') <> 'on' then
    raise exception 'email_plan_autopilot_required: only a planned email''s deadline sets plan_autopilot'
      using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.email_plan_autopilot_source_guard() from public, anon, authenticated;
drop trigger if exists decisions_plan_autopilot_guard on public.decisions;
create trigger decisions_plan_autopilot_guard before insert or update of approved_by_source on public.decisions
  for each row execute function public.email_plan_autopilot_source_guard();
drop trigger if exists channel_actions_plan_autopilot_guard on public.channel_actions;
create trigger channel_actions_plan_autopilot_guard before insert or update of approved_by_source on public.channel_actions
  for each row execute function public.email_plan_autopilot_source_guard();

create or replace function public.email_plan_unattended_ok(p_tenant_id uuid, p_decision_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d   decisions%rowtype;
  v_row email_planned_sends%rowtype;
begin
  select * into d from decisions where id = p_decision_id and tenant_id = p_tenant_id;
  if not found or d.decision_class is distinct from 'bulk_outbound.send' or d.approved_by_source is distinct from 'plan_autopilot' then
    return jsonb_build_object('ok', false, 'code', 'not_planned');
  end if;
  select * into v_row from email_planned_sends where card_rail = 'decisions' and card_id = p_decision_id and tenant_id = p_tenant_id;
  if not found or not v_row.unattended or v_row.status <> 'sending' then
    return jsonb_build_object('ok', false, 'code', 'not_planned');
  end if;
  if not exists (select 1 from email_send_reservations r
                  where r.tenant_id = p_tenant_id and r.card_rail = 'decisions' and r.card_id = p_decision_id
                    and r.list_key = v_row.list_key and r.state <> 'released') then
    return jsonb_build_object('ok', false, 'code', 'not_planned');
  end if;
  if coalesce((d.body->>'approved_count')::int, 0) not between 1 and 1000 then
    return jsonb_build_object('ok', false, 'code', 'audience_over_limit');
  end if;
  if public._email_test_list_marked(p_tenant_id, v_row.list_key) then
    return jsonb_build_object('ok', false, 'code', 'email_test_list');
  end if;
  if not exists (select 1 from email_lists l join email_list_versions v on v.id = l.active_version_id and v.tenant_id = l.tenant_id
                  where l.tenant_id = p_tenant_id and l.id = (d.body->>'list_id')::uuid and l.archived_at is null
                    and l.active_version_id = (d.body->>'list_version_id')::uuid and v.consent_confirmed_at is not null) then
    return jsonb_build_object('ok', false, 'code', 'list_version_changed');
  end if;
  return jsonb_build_object('ok', true, 'approved_count', (d.body->>'approved_count')::int);
exception when invalid_text_representation then
  return jsonb_build_object('ok', false, 'code', 'not_planned');
end $$;
revoke all on function public.email_plan_unattended_ok(uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_plan_unattended_ok(uuid, uuid) to service_role;

create or replace function public.approve_email_card(
  p_tenant_id      uuid,
  p_rail           text,
  p_id             uuid,
  p_variant        int,
  p_actor_user_id  uuid,
  p_event_key      text,
  p_approved_count int
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c        record;
  v_sha    text;
  v_out    jsonb;
  v_pre    record;
  v_key    text;
  v_marked boolean := false;
begin
  if p_tenant_id is null or p_id is null or p_actor_user_id is null or p_rail not in ('channel_actions', 'decisions') then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into v_pre from public._email_card(p_tenant_id, p_rail, p_id, false);
  if not coalesce(v_pre.o_found, false) then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  v_key := public._email_test_list_key(v_pre.o_class, v_pre.o_body);
  v_marked := public._email_test_list_marked(p_tenant_id, v_key);
  select * into c from public._email_card(p_tenant_id, p_rail, p_id, true);
  if not c.o_found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if public._email_test_list_key(c.o_class, c.o_body) is distinct from v_key then
    return jsonb_build_object('ok', false, 'code', 'card_changed');
  end if;
  if public._email_card_versions(c.o_body) = 0 then
    return jsonb_build_object('ok', false, 'code', 'redraft_required');
  end if;
  if v_marked then
    return jsonb_build_object('ok', false, 'code', 'test_list');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id
                    and role in ('owner', 'admin')) then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  if p_variant is null or p_variant < 1 or p_variant > public._email_card_versions(c.o_body) then
    return jsonb_build_object('ok', false, 'code', 'bad_variant');
  end if;
  if c.o_open and c.o_body ? 'planned_send_id' and not exists (
       select 1 from email_planned_sends s
        where s.tenant_id = p_tenant_id and s.card_rail = p_rail and s.card_id = p_id
          and s.id::text = c.o_body->>'planned_send_id'
          and s.content_version::text = c.o_body->>'plan_version'
          and s.status in ('ready', 'scheduled', 'skipped', 'blocked')) then
    return jsonb_build_object('ok', false, 'code', 'plan_changed');
  end if;
  if not c.o_open then
    if not c.o_approved or (c.o_body->>'chosen_variant')::int is distinct from p_variant then
      return jsonb_build_object('ok', false, 'code', 'not_open', 'status', c.o_status);
    end if;
    if p_rail = 'channel_actions' then
      return public._email_card_retry(p_tenant_id, p_id, p_actor_user_id, p_event_key, p_approved_count);
    end if;
    if c.o_status in ('approved', 'dispatching') then
      return jsonb_build_object('ok', true, 'changed', false, 'status', c.o_status, 'class', c.o_class);
    end if;
    return jsonb_build_object('ok', false, 'code', 'not_open', 'status', c.o_status);
  end if;
  v_sha := public.email_card_test_sha(c.o_body, p_variant);
  if not exists (select 1 from email_test_sends t
                   join tenant_users tu on tu.tenant_id = t.tenant_id and tu.user_id = t.user_id
                  where t.tenant_id = p_tenant_id and t.rail = p_rail and t.card_id = p_id
                    and t.variant = p_variant and t.test_sha = v_sha and tu.role in ('owner', 'admin')) then
    return jsonb_build_object('ok', false, 'code', 'test_required');
  end if;
  if p_approved_count is null or p_approved_count < 1 then
    return jsonb_build_object('ok', false, 'code', 'count_required');
  end if;

  perform set_config('zavi.email_card_approve', 'on', true);
  if p_rail = 'channel_actions' then
    v_out := approve_channel_action(p_tenant_id, p_id, coalesce(p_event_key, 'email-card'), p_actor_user_id, null);
    if coalesce((v_out->>'ok')::boolean, false) then
      update channel_actions
         set exec_payload = exec_payload || jsonb_build_object('chosen_variant', p_variant, 'approved_count', p_approved_count)
       where id = p_id;
    end if;
  else
    update decisions
       set body        = body || jsonb_build_object('chosen_variant', p_variant, 'approved_count', p_approved_count),
           status      = 'approved',
           approved_by = p_actor_user_id,
           approved_at = now()
     where id = p_id and status = 'proposed';
    v_out := jsonb_build_object('ok', true, 'changed', true, 'status', 'approved', 'class', c.o_class);
  end if;
  perform set_config('zavi.email_card_approve', '', true);
  return v_out;
end $$;
revoke all on function public.approve_email_card(uuid, text, uuid, int, uuid, text, int) from public, anon, authenticated;
grant execute on function public.approve_email_card(uuid, text, uuid, int, uuid, text, int) to service_role;

create or replace function approve_email_campaign_send_as_cgo(
  p_tenant_id      uuid,
  p_action_id      uuid,
  p_event_key      text,
  p_actor_user_id  uuid,
  p_approved_count int default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row      channel_actions%rowtype;
  v_tool     text;
  v_audience text;
  v_out      jsonb;
  v_versions boolean;
begin
  if p_tenant_id is null or p_action_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into v_row from channel_actions where id = p_action_id;
  if not found or v_row.tenant_id is distinct from p_tenant_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_row.exec_class is distinct from 'email_campaign.create_and_send' then
    return jsonb_build_object('ok', false, 'code', 'not_email_send');
  end if;
  if v_row.exec_payload ? 'planned_send_id'
     and coalesce(current_setting('zavi.email_plan_fire', true), '') <> 'on' then
    return jsonb_build_object('ok', false, 'code', 'planned_card_deadline_only');
  end if;
  v_tool     := nullif(trim(v_row.exec_payload->>'tool'), '');
  v_audience := nullif(trim(v_row.exec_payload->>'audience_id'), '');
  if v_tool is null or v_audience is null then
    return jsonb_build_object('ok', false, 'code', 'audience_unknown');
  end if;
  if public._email_test_list_marked(p_tenant_id, v_tool || ':' || v_audience) then
    return jsonb_build_object('ok', false, 'code', 'test_list');
  end if;
  v_versions := public._email_card_versions(v_row.exec_payload) > 0;
  if v_versions and v_row.exec_status is null and (p_approved_count is null or p_approved_count < 1) then
    return jsonb_build_object('ok', false, 'code', 'count_required');
  end if;
  if v_versions and p_approved_count > 1000 then
    return jsonb_build_object('ok', false, 'code', 'audience_over_limit');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cgo_email_send:' || p_tenant_id::text || ':' || v_tool || ':' || v_audience, 0));

  if public._email_list_sent_near(p_tenant_id, v_tool || ':' || v_audience, now(), 'channel_actions', p_action_id) is not null then
    return jsonb_build_object('ok', false, 'code', 'cgo_email_sent_recently');
  end if;

  perform set_config('zavi.email_card_approve', 'on', true);
  v_out := approve_channel_action(p_tenant_id, p_action_id, p_event_key, p_actor_user_id, 'cgo');
  if v_versions and coalesce((v_out->>'ok')::boolean, false) and not coalesce((v_out->>'replayed')::boolean, false) then
    update channel_actions
       set exec_payload = exec_payload || jsonb_build_object('chosen_variant', 1, 'approved_count', p_approved_count)
     where id = p_action_id;
  end if;
  perform set_config('zavi.email_card_approve', '', true);
  return v_out;
end $$;

revoke all on function approve_email_campaign_send_as_cgo(uuid, uuid, text, uuid, int)
  from public, anon, authenticated;
grant execute on function approve_email_campaign_send_as_cgo(uuid, uuid, text, uuid, int) to service_role;

create or replace function public.email_list_version_freeze_count(p_tenant_id uuid, p_version_id uuid) returns int
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return (select count(*)::int
            from public.email_list_version_contacts m
            join public.email_contacts c on c.tenant_id = m.tenant_id and c.id = m.contact_id
           where m.tenant_id = p_tenant_id and m.version_id = p_version_id
             and c.erased_at is null and c.email_norm is not null);
end $$;
revoke all on function public.email_list_version_freeze_count(uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_list_version_freeze_count(uuid, uuid) to service_role;

create or replace function public.email_bulk_freeze_send(
  p_tenant_id    uuid,
  p_decision_id  uuid,
  p_list_id      uuid,
  p_version_id   uuid,
  p_subject      text,
  p_body_text    text,
  p_from_address text,
  p_reply_to     text,
  p_cap          int,
  p_body_html    text default null,
  p_render_sha   text default null
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_send  public.email_bulk_sends%rowtype;
  v_total int;
  v_cap   int := least(coalesce(p_cap, 0), 1000);
begin
  if p_tenant_id is null or p_decision_id is null or p_list_id is null or p_version_id is null
     or p_subject is null or p_body_text is null or p_from_address is null
     or p_cap is null or p_cap < 1
     or ((p_body_html is null) <> (p_render_sha is null)) then
    raise exception 'email_bulk_freeze_send: invalid argument' using errcode = '22023';
  end if;

  select * into v_send from public.email_bulk_sends s
   where s.decision_id = p_decision_id and s.tenant_id = p_tenant_id;
  if found then
    return jsonb_build_object('ok', true, 'created', false, 'send_id', v_send.id,
                              'total', v_send.total, 'status', v_send.status);
  end if;

  if exists (select 1 from public.email_bulk_abuse_holds a
              where a.tenant_id = p_tenant_id and a.cleared_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'abuse_hold');
  end if;
  if not exists (select 1 from public.decisions d
                  where d.id = p_decision_id and d.tenant_id = p_tenant_id
                    and d.decision_class = 'bulk_outbound.send'
                    and d.approved_by is not null
                    and d.status in ('approved', 'dispatching')) then
    return jsonb_build_object('ok', false, 'reason', 'not_approved');
  end if;
  if not exists (select 1 from public.email_lists l
                  where l.id = p_list_id and l.tenant_id = p_tenant_id and l.archived_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'list_archived');
  end if;
  if not exists (select 1 from public.email_list_versions v
                  where v.id = p_version_id and v.list_id = p_list_id and v.tenant_id = p_tenant_id
                    and v.consent_confirmed_at is not null) then
    return jsonb_build_object('ok', false, 'reason', 'version_not_consented');
  end if;
  if exists (select 1 from public.decisions d
              where d.id = p_decision_id and d.tenant_id = p_tenant_id and d.approved_by_source = 'plan_autopilot') then
    perform 1 from public.email_lists l where l.id = p_list_id and l.tenant_id = p_tenant_id for update;
    if not exists (select 1 from public.email_lists l
                    where l.id = p_list_id and l.tenant_id = p_tenant_id and l.active_version_id = p_version_id) then
      return jsonb_build_object('ok', false, 'reason', 'list_version_changed');
    end if;
    if public.email_list_version_freeze_count(p_tenant_id, p_version_id) > 1000 then
      return jsonb_build_object('ok', false, 'reason', 'audience_over_limit');
    end if;
  end if;

  insert into public.email_bulk_sends
    (tenant_id, decision_id, list_id, list_version_id, subject, body_text, body_html, render_sha, from_address, reply_to)
  values
    (p_tenant_id, p_decision_id, p_list_id, p_version_id, p_subject, p_body_text, p_body_html, p_render_sha, p_from_address, p_reply_to)
  on conflict (decision_id) do nothing
  returning * into v_send;
  if v_send.id is null then
    select * into v_send from public.email_bulk_sends s
     where s.decision_id = p_decision_id and s.tenant_id = p_tenant_id;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'not_approved');
    end if;
    return jsonb_build_object('ok', true, 'created', false, 'send_id', v_send.id,
                              'total', v_send.total, 'status', v_send.status);
  end if;

  insert into public.email_bulk_send_recipients (send_id, tenant_id, contact_id, email_at_send)
  select v_send.id, p_tenant_id, x.id, x.email_norm
    from (
      select c.id, c.email_norm
        from public.email_list_version_contacts m
        join public.email_contacts c on c.tenant_id = m.tenant_id and c.id = m.contact_id
       where m.tenant_id = p_tenant_id and m.version_id = p_version_id
         and c.erased_at is null and c.email_norm is not null
       order by c.email_norm
       limit v_cap
    ) x;
  get diagnostics v_total = row_count;
  update public.email_bulk_sends s set total = v_total
   where s.id = v_send.id and s.tenant_id = p_tenant_id;

  return jsonb_build_object('ok', true, 'created', true, 'send_id', v_send.id,
                            'total', v_total, 'status', 'sending');
end $$;
revoke all on function public.email_bulk_freeze_send(uuid, uuid, uuid, uuid, text, text, text, text, int, text, text) from public, anon, authenticated;
grant execute on function public.email_bulk_freeze_send(uuid, uuid, uuid, uuid, text, text, text, text, int, text, text) to service_role;

create or replace function public.claim_email_plan_jobs(p_limit int, p_lease_seconds int) returns setof public.email_plan_jobs
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  with due as (
    select j.id from email_plan_jobs j
     where j.due_at <= now()
       and (j.state = 'pending' or (j.state = 'leased' and j.lease_until < now()))
     order by j.due_at
     limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update skip locked
  )
  update email_plan_jobs j
     set state = 'leased', lease_token = gen_random_uuid(),
         lease_until = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 600), 1800))),
         attempts = j.attempts + 1
    from due where j.id = due.id
  returning j.*;
end $$;
revoke all on function public.claim_email_plan_jobs(int, int) from public, anon, authenticated;
grant execute on function public.claim_email_plan_jobs(int, int) to service_role;

create or replace function public.complete_email_plan_job(
  p_tenant_id uuid, p_id uuid, p_token uuid, p_outcome text, p_error text, p_retry_seconds int
) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  if p_outcome = 'retry' then
    update email_plan_jobs
       set state = 'pending', lease_token = null, lease_until = null, last_error = left(p_error, 300),
           due_at = now() + make_interval(secs => greatest(30, least(coalesce(p_retry_seconds, 600), 86400)))
     where id = p_id and tenant_id = p_tenant_id and lease_token = p_token and state = 'leased';
  else
    update email_plan_jobs set state = 'done', lease_token = null, lease_until = null, last_error = left(p_error, 300)
     where id = p_id and tenant_id = p_tenant_id and lease_token = p_token and state = 'leased';
  end if;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.complete_email_plan_job(uuid, uuid, uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.complete_email_plan_job(uuid, uuid, uuid, text, text, int) to service_role;

create or replace function public.repair_email_plan_jobs(p_limit int) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_n int := 0;
begin
  for r in
    select s.* from email_planned_sends s
     where s.status in ('planned', 'drafting', 'ready', 'scheduled')
       and (not exists (select 1 from email_plan_jobs j where j.tenant_id = s.tenant_id and j.item_id = s.id
                          and j.kind = 'deadline' and j.state <> 'done'
                          and j.job_key = 'deadline:' || s.id || ':g' || s.schedule_gen)
            or (s.card_id is null and s.status in ('planned', 'drafting')
                and not exists (select 1 from email_plan_jobs j where j.tenant_id = s.tenant_id and j.item_id = s.id
                                  and j.kind = 'draft' and j.state <> 'done')))
     order by s.planned_at
     limit greatest(1, least(coalesce(p_limit, 200), 1000))
  loop
    perform public._email_plan_job(r.tenant_id, r.id, 'deadline', 'deadline:' || r.id || ':g' || r.schedule_gen, r.planned_at);
    if r.card_id is null and r.status in ('planned', 'drafting')
       and not exists (select 1 from email_plan_jobs j where j.tenant_id = r.tenant_id and j.item_id = r.id and j.kind = 'draft' and j.state <> 'done') then
      perform public._email_plan_job(r.tenant_id, r.id, 'draft',
        'draft:' || r.id || ':v' || r.content_version || ':g' || r.schedule_gen || ':repair:' || r.draft_attempts,
        greatest(now(), r.planned_at - interval '24 hours'));
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.repair_email_plan_jobs(int) from public, anon, authenticated;
grant execute on function public.repair_email_plan_jobs(int) to service_role;

create or replace function public.email_plan_outbox_pending(p_limit int) returns setof public.email_plan_outbox
language sql stable security definer set search_path = public, pg_temp as $$
  select * from email_plan_outbox where sent_at is null order by created_at limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;
revoke all on function public.email_plan_outbox_pending(int) from public, anon, authenticated;
grant execute on function public.email_plan_outbox_pending(int) to service_role;

create or replace function public.mark_email_plan_outbox_sent(p_tenant_id uuid, p_event_id text) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  update email_plan_outbox set sent_at = now() where tenant_id = p_tenant_id and event_id = p_event_id and sent_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.mark_email_plan_outbox_sent(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_email_plan_outbox_sent(uuid, text) to service_role;

create or replace function public.set_email_plan_schedule(p_tenant_id uuid, p_next timestamptz, p_tz text) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into email_plan_schedule (tenant_id, next_run_at, timezone) values (p_tenant_id, p_next, p_tz)
  on conflict (tenant_id) do update set next_run_at = excluded.next_run_at, timezone = excluded.timezone, updated_at = now(),
                                        zone_checked_at = now()
   where email_plan_schedule.lease_until is null or email_plan_schedule.lease_until < now();
$$;

create or replace function public.claim_email_plan_zone_checks(p_limit int) returns setof public.email_plan_schedule
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  with stale as (
    select s.tenant_id from email_plan_schedule s
     where (s.zone_checked_at is null or s.zone_checked_at < now() - interval '1 hour')
       and (s.lease_until is null or s.lease_until < now())
     order by s.zone_checked_at nulls first limit greatest(1, least(coalesce(p_limit, 25), 200))
     for update skip locked
  )
  update email_plan_schedule s set zone_checked_at = now() from stale where s.tenant_id = stale.tenant_id
  returning s.*;
end $$;
revoke all on function public.claim_email_plan_zone_checks(int) from public, anon, authenticated;
grant execute on function public.claim_email_plan_zone_checks(int) to service_role;
revoke all on function public.set_email_plan_schedule(uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.set_email_plan_schedule(uuid, timestamptz, text) to service_role;

create or replace function public.claim_email_plan_schedules(p_limit int) returns setof public.email_plan_schedule
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  with due as (
    select s.tenant_id from email_plan_schedule s
     where s.next_run_at <= now() and (s.lease_until is null or s.lease_until < now())
     order by s.next_run_at limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update skip locked
  )
  update email_plan_schedule s set lease_token = gen_random_uuid(), lease_until = now() + interval '10 minutes'
    from due where s.tenant_id = due.tenant_id
  returning s.*;
end $$;
revoke all on function public.claim_email_plan_schedules(int) from public, anon, authenticated;
grant execute on function public.claim_email_plan_schedules(int) to service_role;

create or replace function public.finish_email_plan_schedule(p_tenant_id uuid, p_token uuid, p_next timestamptz, p_request text, p_tz text default null) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  update email_plan_schedule
     set next_run_at = coalesce(p_next, next_run_at), timezone = coalesce(p_tz, timezone),
         lease_token = null, lease_until = null, updated_at = now(),
         last_run_at = case when p_request is null then last_run_at else now() end,
         last_request = coalesce(p_request, last_request)
   where tenant_id = p_tenant_id and lease_token = p_token;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.finish_email_plan_schedule(uuid, uuid, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.finish_email_plan_schedule(uuid, uuid, timestamptz, text, text) to service_role;

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
               order by r.reserved_at limit 20) r), '[]'::jsonb));
end $$;
revoke all on function public.list_email_planned_sends(uuid, uuid) from public, anon, authenticated;
grant execute on function public.list_email_planned_sends(uuid, uuid) to service_role;

create or replace function public.email_planned_for_card(p_tenant_id uuid, p_rail text, p_card_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', s.id, 'planned_at', s.planned_at, 'timezone', s.planned_tz, 'status', s.status,
                            'status_reason', s.status_reason, 'schedule_gen', s.schedule_gen, 'vetoed', s.vetoed_at is not null,
                            'scheduled', case when s.sched_at is null then null
                              else jsonb_build_object('variant', s.sched_variant, 'count', s.sched_count, 'by', s.sched_by) end)
    from email_planned_sends s where s.tenant_id = p_tenant_id and s.card_rail = p_rail and s.card_id = p_card_id;
$$;
revoke all on function public.email_planned_for_card(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.email_planned_for_card(uuid, text, uuid) to service_role;

create or replace function public.discard_email_planned_card(p_tenant_id uuid, p_rail text, p_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record;
begin
  if p_rail not in ('channel_actions', 'decisions') then return false; end if;
  select * into c from public._email_card(p_tenant_id, p_rail, p_id, false);
  if not coalesce(c.o_found, false) or not (c.o_body ? 'planned_send_id') then return false; end if;
  if exists (select 1 from email_planned_sends where card_rail = p_rail and card_id = p_id) then return false; end if;
  return public._email_plan_reject_card(p_tenant_id, p_rail, p_id, 'plan_changed');
end $$;
revoke all on function public.discard_email_planned_card(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.discard_email_planned_card(uuid, text, uuid) to service_role;

create or replace function public.email_plan_schedule_missing(p_limit int) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select t.id from tenants t
   where not exists (select 1 from email_plan_schedule s where s.tenant_id = t.id)
   limit greatest(1, least(coalesce(p_limit, 50), 500));
$$;
revoke all on function public.email_plan_schedule_missing(int) from public, anon, authenticated;
grant execute on function public.email_plan_schedule_missing(int) to service_role;

commit;
