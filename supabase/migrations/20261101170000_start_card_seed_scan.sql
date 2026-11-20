
begin;

alter table public.start_cards
  add column if not exists seed_run_id uuid,
  add column if not exists notice_sent_at timestamptz;

alter table public.start_cards drop constraint if exists start_cards_funding_kind_chk;
alter table public.start_cards add constraint start_cards_funding_kind_chk
  check (funding_kind in ('public_budget', 'tenant_credits', 'seed'));

alter table public.start_cards drop constraint if exists start_cards_funding_ref_chk;
alter table public.start_cards add constraint start_cards_funding_ref_chk check (
  (funding_kind = 'public_budget'
     and funding_tenant_id is null and requested_by_run_id is null
     and tool_call_id is null and delivery_state is null
     and seed_run_id is null and notice_sent_at is null)
  or
  (funding_kind = 'tenant_credits'
     and funding_tenant_id is not null and requested_by_run_id is not null
     and tool_call_id is not null and length(tool_call_id) between 1 and 200
     and delivery_state is not null and budget_day is null
     and seed_run_id is null and notice_sent_at is null)
  or
  (funding_kind = 'seed'
     and seed_run_id is not null and budget_day is null and reserved_usd = 0
     and funding_tenant_id is null and requested_by_run_id is null
     and tool_call_id is null and delivery_state is null and ip_hash is null)
) not valid;
alter table public.start_cards validate constraint start_cards_funding_ref_chk;

create unique index if not exists start_cards_seed_run_domain_uq
  on public.start_cards (seed_run_id, domain) where seed_run_id is not null;

create table if not exists public.seed_runs (
  id               uuid primary key default gen_random_uuid(),
  manifest_hash    text not null check (manifest_hash ~ '^[0-9a-f]{64}$'),
  pipeline_version text not null check (length(pipeline_version) between 1 and 200),
  privacy_version  text not null check (length(privacy_version) between 1 and 100),
  status           text not null default 'open' check (status in ('open', 'closed')),
  lease_holder     text,
  lease_until      timestamptz,
  spend_cap_usd    numeric(10,2) not null check (spend_cap_usd > 0),
  spent_usd        numeric(10,4) not null default 0 check (spent_usd >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.seed_run_items (
  run_id      uuid not null references public.seed_runs(id) on delete cascade,
  domain      text not null check (length(domain) between 1 and 253
                and domain = lower(btrim(domain)) and domain not like 'www.%'),
  source      text not null check (source in ('product_hunt', 'yc')),
  state       text not null default 'pending'
                check (state in ('pending', 'running', 'done', 'skipped', 'failed')),
  attempts    int not null default 0 check (attempts >= 0),
  card_id     uuid references public.start_cards(id) on delete set null,
  reason      text check (reason is null or length(reason) <= 200),
  reserved_usd numeric(10,4) not null default 0 check (reserved_usd >= 0),
  actual_usd   numeric(10,4) check (actual_usd is null or actual_usd >= 0),
  settled_at   timestamptz,
  updated_at  timestamptz not null default now(),
  primary key (run_id, domain)
);

create table if not exists public.seed_suppressions (
  domain      text primary key check (length(domain) between 1 and 253
                and domain = lower(btrim(domain)) and domain not like 'www.%'),
  reason      text not null check (reason in ('owner_removed', 'manual')),
  created_at  timestamptz not null default now()
);

create table if not exists public.seed_notices (
  domain              text primary key check (length(domain) between 1 and 253
                        and domain = lower(btrim(domain)) and domain not like 'www.%'),
  card_id             uuid references public.start_cards(id) on delete set null,
  email               text not null check (length(email) between 3 and 320
                        and (lower(split_part(email, '@', 2)) = domain
                             or lower(split_part(email, '@', 2)) like ('%.' || domain))),
  idempotency_key     text not null unique check (length(idempotency_key) between 16 and 100),
  state               text not null default 'pending'
                        check (state in ('pending', 'claimed', 'accepted', 'bounced', 'unknown', 'cancelled')),
  provider_message_id text check (provider_message_id is null or length(provider_message_id) <= 300),
  claimed_at          timestamptz,
  accepted_at         timestamptz,
  error               text check (error is null or length(error) <= 300),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.seed_runs enable row level security;
alter table public.seed_runs force row level security;
alter table public.seed_run_items enable row level security;
alter table public.seed_run_items force row level security;
alter table public.seed_suppressions enable row level security;
alter table public.seed_suppressions force row level security;
alter table public.seed_notices enable row level security;
alter table public.seed_notices force row level security;

revoke all on table public.seed_runs from public, anon, authenticated;
revoke all on table public.seed_run_items from public, anon, authenticated;
revoke all on table public.seed_suppressions from public, anon, authenticated;
revoke all on table public.seed_notices from public, anon, authenticated;
grant all on table public.seed_runs to service_role;
grant all on table public.seed_run_items to service_role;
grant all on table public.seed_suppressions to service_role;
grant all on table public.seed_notices to service_role;

create or replace function public.start_card_suppress_on_revoke()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_domain text := regexp_replace(lower(btrim(new.domain)), '^www\.', '');
begin
  if new.revoked_at is not null and old.revoked_at is null then
    perform pg_advisory_xact_lock(hashtextextended('start_card_domain:' || v_domain, 0));
    insert into seed_suppressions (domain, reason) values (v_domain, 'owner_removed')
      on conflict (domain) do nothing;
    update seed_notices set state = 'cancelled', updated_at = now()
     where domain = v_domain and state in ('pending', 'claimed');
  end if;
  return new;
end $$;

drop trigger if exists start_cards_suppress_on_revoke on public.start_cards;
create trigger start_cards_suppress_on_revoke
  after update of revoked_at on public.start_cards
  for each row execute function public.start_card_suppress_on_revoke();

revoke all on function public.start_card_suppress_on_revoke() from public, anon, authenticated;

create or replace function public.seed_suppression_lock_domain()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('start_card_domain:' || new.domain, 0));
  return new;
end $$;

create or replace function public.seed_suppression_cancel_notice()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  update seed_notices set state = 'cancelled', updated_at = now()
   where domain = new.domain and state in ('pending', 'claimed');
  return new;
end $$;

drop trigger if exists seed_suppressions_lock_domain on public.seed_suppressions;
create trigger seed_suppressions_lock_domain
  before insert on public.seed_suppressions
  for each row execute function public.seed_suppression_lock_domain();

drop trigger if exists seed_suppressions_cancel_notice on public.seed_suppressions;
create trigger seed_suppressions_cancel_notice
  after insert on public.seed_suppressions
  for each row execute function public.seed_suppression_cancel_notice();

revoke all on function public.seed_suppression_lock_domain() from public, anon, authenticated;
revoke all on function public.seed_suppression_cancel_notice() from public, anon, authenticated;

create or replace function public.seed_notice_check_card()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' and new.card_id is null then
    raise exception 'a seed notice needs its card' using errcode = '23514';
  end if;
  if new.card_id is not null and not exists (
    select 1 from start_cards
     where id = new.card_id and funding_kind = 'seed'
       and regexp_replace(lower(domain), '^www\.', '') = new.domain
  ) then
    raise exception 'seed notice must belong to a seed card of the same domain' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists seed_notices_check_card on public.seed_notices;
create trigger seed_notices_check_card
  before insert or update of card_id, domain on public.seed_notices
  for each row execute function public.seed_notice_check_card();

revoke all on function public.seed_notice_check_card() from public, anon, authenticated;

create or replace function public.start_card_seed_claim(
  p_run_id    uuid,
  p_domain    text,
  p_public_id text,
  p_parts     jsonb
) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_domain text := regexp_replace(lower(nullif(btrim(p_domain), '')), '^www\.', '');
  v_status text;
  v_id     uuid;
  v_pub    text;
  v_cstat  text;
begin
  if p_run_id is null or v_domain is null or nullif(p_public_id, '') is null then
    raise exception 'start_card_seed_claim: run, domain and public_id are required' using errcode = '22023';
  end if;
  select status into v_status from seed_runs where id = p_run_id for share;
  if v_status is null then
    raise exception 'start_card_seed_claim: no such seed run' using errcode = '22023';
  end if;
  if v_status <> 'open' then
    return jsonb_build_object('outcome', 'run_closed');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('start_card_domain:' || v_domain, 0));

  if exists (select 1 from seed_suppressions where domain = v_domain)
     or exists (select 1 from start_cards
                 where regexp_replace(lower(domain), '^www\.', '') = v_domain and revoked_at is not null) then
    return jsonb_build_object('outcome', 'suppressed');
  end if;

  select id, public_id, status into v_id, v_pub, v_cstat
    from start_cards where seed_run_id = p_run_id and domain = v_domain;
  if v_id is not null then
    return jsonb_build_object('outcome', 'same_run', 'id', v_id, 'public_id', v_pub, 'status', v_cstat);
  end if;

  if not exists (select 1 from seed_run_items
                  where run_id = p_run_id and domain = v_domain and reserved_usd > 0 and settled_at is null) then
    return jsonb_build_object('outcome', 'not_reserved');
  end if;

  insert into start_cards (public_id, domain, status, parts, budget_day, reserved_usd, funding_kind, seed_run_id)
  values (p_public_id, v_domain, 'running', coalesce(p_parts, '{}'::jsonb), null, 0, 'seed', p_run_id)
  returning id, public_id into v_id, v_pub;

  return jsonb_build_object('outcome', 'created', 'id', v_id, 'public_id', v_pub, 'status', 'running');
end $$;

revoke all on function public.start_card_seed_claim(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.start_card_seed_claim(uuid, text, text, jsonb) to service_role;

create or replace function public.seed_notice_claim(p_domain text)
returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_domain text := regexp_replace(lower(nullif(btrim(p_domain), '')), '^www\.', '');
  v_n      seed_notices%rowtype;
begin
  if v_domain is null then
    raise exception 'seed_notice_claim: domain is required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('start_card_domain:' || v_domain, 0));
  select * into v_n from seed_notices where domain = v_domain for update;
  if v_n.domain is null then return jsonb_build_object('outcome', 'no_notice'); end if;
  if v_n.state <> 'pending' then return jsonb_build_object('outcome', 'not_pending', 'state', v_n.state); end if;
  if exists (select 1 from seed_suppressions where domain = v_domain)
     or v_n.card_id is null
     or exists (select 1 from start_cards where id = v_n.card_id and (revoked_at is not null or status <> 'done')) then
    update seed_notices set state = 'cancelled', updated_at = now() where domain = v_domain;
    return jsonb_build_object('outcome', 'cancelled');
  end if;
  update seed_notices set state = 'claimed', claimed_at = now(), updated_at = now() where domain = v_domain;
  return jsonb_build_object('outcome', 'claimed', 'email', v_n.email, 'idempotency_key', v_n.idempotency_key, 'card_id', v_n.card_id);
end $$;

create or replace function public.seed_notice_accepted(p_domain text, p_provider_message_id text)
returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_domain text := regexp_replace(lower(nullif(btrim(p_domain), '')), '^www\.', '');
  v_card   uuid;
  v_n      seed_notices%rowtype;
begin
  if v_domain is null or nullif(btrim(p_provider_message_id), '') is null then
    raise exception 'seed_notice_accepted: domain and the provider message id are required' using errcode = '22023';
  end if;
  select card_id into v_card from seed_notices where domain = v_domain;
  if not found then return jsonb_build_object('outcome', 'not_claimed'); end if;
  if v_card is null then
    perform pg_advisory_xact_lock(hashtextextended('start_card_domain:' || v_domain, 0));
    update seed_notices
       set state = 'accepted', accepted_at = now(), provider_message_id = p_provider_message_id, updated_at = now()
     where domain = v_domain and state = 'claimed' and card_id is null;
    return jsonb_build_object('outcome', case when found then 'accepted_no_card' else 'not_claimed' end);
  end if;
  perform 1 from start_cards where id = v_card for update;
  perform pg_advisory_xact_lock(hashtextextended('start_card_domain:' || v_domain, 0));
  select * into v_n from seed_notices where domain = v_domain for update;
  if v_n.state is distinct from 'claimed' then
    return jsonb_build_object('outcome', 'not_claimed');
  end if;
  if v_n.card_id is null then
    update seed_notices
       set state = 'accepted', accepted_at = now(), provider_message_id = p_provider_message_id, updated_at = now()
     where domain = v_domain;
    return jsonb_build_object('outcome', 'accepted_no_card');
  end if;
  if v_n.card_id is distinct from v_card then
    return jsonb_build_object('outcome', 'not_claimed');
  end if;
  update seed_notices
     set state = 'accepted', accepted_at = now(), provider_message_id = p_provider_message_id, updated_at = now()
   where domain = v_domain;
  if exists (select 1 from seed_suppressions where domain = v_domain) then
    return jsonb_build_object('outcome', 'accepted_suppressed', 'card_id', v_card);
  end if;
  update start_cards set notice_sent_at = now(), updated_at = now()
   where id = v_card and funding_kind = 'seed' and notice_sent_at is null and revoked_at is null;
  return jsonb_build_object('outcome', 'accepted', 'card_id', v_card);
end $$;

create or replace function public.start_card_guard_notice_sent()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if new.notice_sent_at is not null
     and (tg_op = 'INSERT' or old.notice_sent_at is null)
     and not exists (select 1 from seed_notices where card_id = new.id and state = 'accepted') then
    raise exception 'notice_sent_at needs an accepted seed notice for this card' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists start_cards_guard_notice_sent on public.start_cards;
create trigger start_cards_guard_notice_sent
  before insert or update of notice_sent_at on public.start_cards
  for each row execute function public.start_card_guard_notice_sent();

create or replace function public.seed_run_reserve(p_run_id uuid, p_domain text, p_usd numeric)
returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_domain text := regexp_replace(lower(nullif(btrim(p_domain), '')), '^www\.', '');
  v_spent numeric; v_cap numeric; v_res numeric; v_settled timestamptz;
begin
  if p_run_id is null or v_domain is null or p_usd is null or p_usd <= 0 then
    raise exception 'seed_run_reserve: run, domain and a positive amount are required' using errcode = '22023';
  end if;
  select spent_usd, spend_cap_usd into v_spent, v_cap from seed_runs where id = p_run_id for update;
  if v_cap is null then raise exception 'seed_run_reserve: no such seed run' using errcode = '22023'; end if;
  select reserved_usd, settled_at into v_res, v_settled from seed_run_items
   where run_id = p_run_id and domain = v_domain for update;
  if not found then raise exception 'seed_run_reserve: no such item in this run' using errcode = '22023'; end if;
  if v_settled is not null then return jsonb_build_object('outcome', 'settled'); end if;
  if v_res > 0 then return jsonb_build_object('outcome', 'already_reserved', 'reserved_usd', v_res); end if;
  if v_spent + p_usd > v_cap then
    return jsonb_build_object('outcome', 'cap_reached', 'spent_usd', v_spent, 'cap_usd', v_cap);
  end if;
  update seed_runs set spent_usd = spent_usd + p_usd, updated_at = now() where id = p_run_id;
  update seed_run_items set reserved_usd = p_usd, updated_at = now() where run_id = p_run_id and domain = v_domain;
  return jsonb_build_object('outcome', 'reserved', 'spent_usd', v_spent + p_usd, 'cap_usd', v_cap);
end $$;

create or replace function public.seed_run_settle(p_run_id uuid, p_domain text, p_actual_usd numeric)
returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_domain text := regexp_replace(lower(nullif(btrim(p_domain), '')), '^www\.', '');
  v_res numeric; v_settled timestamptz;
begin
  if p_run_id is null or v_domain is null or p_actual_usd is null or p_actual_usd < 0 then
    raise exception 'seed_run_settle: run, domain and a non-negative amount are required' using errcode = '22023';
  end if;
  perform 1 from seed_runs where id = p_run_id for update;
  select reserved_usd, settled_at into v_res, v_settled from seed_run_items
   where run_id = p_run_id and domain = v_domain for update;
  if not found then raise exception 'seed_run_settle: no such item in this run' using errcode = '22023'; end if;
  if v_settled is not null then return jsonb_build_object('outcome', 'already_settled'); end if;
  update seed_runs set spent_usd = spent_usd - v_res + p_actual_usd, updated_at = now() where id = p_run_id;
  update seed_run_items set actual_usd = p_actual_usd, settled_at = now(), updated_at = now()
   where run_id = p_run_id and domain = v_domain;
  return jsonb_build_object('outcome', 'settled', 'actual_usd', p_actual_usd);
end $$;

revoke all on function public.seed_notice_claim(text) from public, anon, authenticated;
revoke all on function public.seed_notice_accepted(text, text) from public, anon, authenticated;
revoke all on function public.start_card_guard_notice_sent() from public, anon, authenticated;
revoke all on function public.seed_run_reserve(uuid, text, numeric) from public, anon, authenticated;
revoke all on function public.seed_run_settle(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.seed_notice_claim(text) to service_role;
grant execute on function public.seed_notice_accepted(text, text) to service_role;
grant execute on function public.seed_run_reserve(uuid, text, numeric) to service_role;
grant execute on function public.seed_run_settle(uuid, text, numeric) to service_role;

create or replace function public.start_card_claim(
  p_domain           text,
  p_since            timestamptz,
  p_public_id        text,
  p_parts            jsonb,
  p_ip_hash          text,
  p_referrer_card_id uuid,
  p_budget_day       date,
  p_reserved_usd     numeric,
  p_funding_kind     text,
  p_tenant_id        uuid,
  p_run_id           uuid,
  p_tool_call_id     text,
  p_delivery_target  jsonb,
  p_run_cap          int
) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_id     uuid;
  v_pub    text;
  v_status text;
  v_tenant uuid;
  v_run_st text;
  v_stop   boolean;
  v_count  int;
begin
  if nullif(p_domain, '') is null or p_since is null or nullif(p_public_id, '') is null
     or p_funding_kind not in ('public_budget', 'tenant_credits') then
    raise exception 'start_card_claim: domain, since, public_id and a known funding kind are required'
      using errcode = '22023';
  end if;

  if p_funding_kind = 'tenant_credits' then
    if p_tenant_id is null or p_run_id is null or nullif(p_tool_call_id, '') is null then
      raise exception 'start_card_claim: a tenant card needs tenant, run and tool call'
        using errcode = '22023';
    end if;
    select tenant_id, status, coalesce(stop_requested, false)
      into v_tenant, v_run_st, v_stop
      from agent_runs where id = p_run_id;
    if v_tenant is null then
      raise exception 'start_card_claim: no such run' using errcode = '22023';
    end if;
    if v_tenant is distinct from p_tenant_id then
      raise exception 'tenant_mismatch' using errcode = '42501';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('start_card_run:' || p_run_id::text, 0));
    select id, public_id, status into v_id, v_pub, v_status
      from start_cards
     where requested_by_run_id = p_run_id and tool_call_id = p_tool_call_id;
    if v_id is not null then
      return jsonb_build_object('outcome', 'same_call', 'id', v_id, 'public_id', v_pub, 'status', v_status);
    end if;
    if v_run_st is distinct from 'running' or v_stop then
      return jsonb_build_object('outcome', 'run_not_running');
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('start_card_domain:' || lower(p_domain), 0));

  select id, public_id, status into v_id, v_pub, v_status
    from start_cards
   where domain = p_domain
     and created_at >= p_since
     and status in ('running', 'done')
     and revoked_at is null
     and funding_kind <> 'seed'
   order by created_at desc
   limit 1;
  if v_id is not null then
    return jsonb_build_object('outcome', 'reused', 'id', v_id, 'public_id', v_pub, 'status', v_status);
  end if;

  if p_funding_kind = 'tenant_credits' then
    select count(*) into v_count from start_cards where requested_by_run_id = p_run_id;
    if v_count >= least(coalesce(p_run_cap, 1), 1) then
      return jsonb_build_object('outcome', 'run_cap', 'count', v_count);
    end if;
  end if;

  insert into start_cards (
    public_id, domain, ip_hash, referrer_card_id, budget_day, reserved_usd, status, parts,
    funding_kind, funding_tenant_id, requested_by_run_id, tool_call_id, delivery_state, delivery_target
  ) values (
    p_public_id, p_domain, p_ip_hash, p_referrer_card_id,
    case when p_funding_kind = 'public_budget' then p_budget_day else null end,
    coalesce(p_reserved_usd, 0), 'running', coalesce(p_parts, '{}'::jsonb),
    p_funding_kind,
    case when p_funding_kind = 'tenant_credits' then p_tenant_id else null end,
    case when p_funding_kind = 'tenant_credits' then p_run_id else null end,
    case when p_funding_kind = 'tenant_credits' then p_tool_call_id else null end,
    case when p_funding_kind = 'tenant_credits' then 'waiting' else null end,
    case when p_funding_kind = 'tenant_credits' then p_delivery_target else null end
  )
  returning id, public_id into v_id, v_pub;

  return jsonb_build_object('outcome', 'created', 'id', v_id, 'public_id', v_pub, 'status', 'running');
end $$;

revoke all on function public.start_card_claim(text, timestamptz, text, jsonb, text, uuid, date, numeric, text, uuid, uuid, text, jsonb, int) from public, anon, authenticated;
grant execute on function public.start_card_claim(text, timestamptz, text, jsonb, text, uuid, date, numeric, text, uuid, uuid, text, jsonb, int) to service_role;

do $$
begin
  raise notice '20261101170000: seed scan (seed cards, claim, runs, suppressions, notices)';
end $$;

commit;
