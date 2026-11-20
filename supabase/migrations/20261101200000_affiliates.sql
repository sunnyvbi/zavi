
create table if not exists public.affiliate_codes (
  member_id  uuid primary key references public.human_members(id) on delete cascade,
  code       text not null unique check (code ~ '^[a-z2-9]{8}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.affiliate_clicks (
  id         uuid primary key default gen_random_uuid(),
  code       text not null references public.affiliate_codes(code) on delete cascade,
  clicked_at timestamptz not null default now()
);
create index if not exists affiliate_clicks_code_time_idx on public.affiliate_clicks (code, clicked_at);
create index if not exists affiliate_clicks_time_idx on public.affiliate_clicks (clicked_at);

create table if not exists public.affiliate_referrals (
  tenant_id       uuid primary key references public.tenants(id) on delete cascade,
  member_id       uuid not null references public.human_members(id) on delete restrict,
  code            text not null,
  click_id        uuid,
  clicked_at      timestamptz not null,
  attributed_at   timestamptz not null default now(),
  door            text not null check (door in ('activate', 'build_start', 'checkout')),
  anchor_at       timestamptz,
  signals         jsonb not null default '{}'::jsonb check (jsonb_typeof(signals) = 'object')
);
create index if not exists affiliate_referrals_member_idx on public.affiliate_referrals (member_id);

create table if not exists public.affiliate_payouts (
  id                 uuid primary key default gen_random_uuid(),
  member_id          uuid not null references public.human_members(id) on delete restrict,
  livemode           boolean not null,
  amount_cents       integer not null check (amount_cents > 0),
  state              text not null check (state in ('awaiting_approval', 'claimed', 'transferring', 'sent', 'failed', 'reconcile', 'rejected', 'cancelled')),
  stripe_transfer_id text unique,
  first_attempt_at   timestamptz,
  destination_account text check (destination_account is null or destination_account ~ '^acct_[A-Za-z0-9]+$'),
  approved_by        uuid,
  error              text check (error is null or length(error) <= 300),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists affiliate_payouts_member_idx on public.affiliate_payouts (member_id, created_at);
create index if not exists affiliate_payouts_open_idx on public.affiliate_payouts (state, created_at) where state in ('awaiting_approval', 'claimed', 'transferring', 'reconcile');

create table if not exists public.affiliate_reversals (
  id                 uuid primary key default gen_random_uuid(),
  member_id          uuid not null references public.human_members(id) on delete restrict,
  payout_id          uuid not null references public.affiliate_payouts(id) on delete restrict,
  livemode           boolean not null,
  amount_cents       integer not null check (amount_cents > 0),
  state              text not null check (state in ('claimed', 'sent', 'failed', 'reconcile')),
  stripe_reversal_id text unique,
  attempted_at       timestamptz,
  error              text check (error is null or length(error) <= 300),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists affiliate_reversals_open_idx on public.affiliate_reversals (member_id, livemode) where state in ('claimed', 'reconcile');

create table if not exists public.affiliate_event_inbox (
  event_id   text primary key check (event_id ~ '^evt_[A-Za-z0-9]+$'),
  attempts   integer not null default 0,
  dead       boolean not null default false,
  last_error text check (last_error is null or length(last_error) <= 300),
  created_at timestamptz not null default now()
);

create table if not exists public.affiliate_entries (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references public.human_members(id) on delete restrict,
  tenant_id    uuid,
  source_key   text not null unique check (length(source_key) between 3 and 300),
  kind         text not null check (kind in ('commission', 'adjustment', 'recovered')),
  amount_cents integer not null,
  charge_id    text,
  invoice_id   text,
  month_index  integer check (month_index is null or month_index between 1 and 12),
  rate         numeric(5, 4) check (rate is null or rate in (0.3, 1.0)),
  base_cents   integer check (base_cents is null or base_cents >= 0),
  livemode     boolean not null,
  matures_at   timestamptz not null,
  payout_id    uuid references public.affiliate_payouts(id) on delete restrict,
  created_at   timestamptz not null default now()
);
create index if not exists affiliate_entries_member_open_idx on public.affiliate_entries (member_id, livemode, matures_at) where payout_id is null;
create index if not exists affiliate_entries_open_matured_idx on public.affiliate_entries (matures_at, member_id) where payout_id is null;
create index if not exists affiliate_entries_charge_idx on public.affiliate_entries (charge_id) where charge_id is not null;
create index if not exists affiliate_entries_payout_idx on public.affiliate_entries (payout_id) where payout_id is not null;

create or replace function public.affiliate_entries_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'affiliate_entries is append-only' using errcode = '42501';
  end if;
  if (new.id, new.member_id, new.tenant_id, new.source_key, new.kind, new.amount_cents, new.charge_id,
      new.invoice_id, new.month_index, new.rate, new.base_cents, new.livemode, new.matures_at, new.created_at)
     is distinct from
     (old.id, old.member_id, old.tenant_id, old.source_key, old.kind, old.amount_cents, old.charge_id,
      old.invoice_id, old.month_index, old.rate, old.base_cents, old.livemode, old.matures_at, old.created_at) then
    raise exception 'affiliate_entries: only payout_id may change' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists affiliate_entries_guard on public.affiliate_entries;
create trigger affiliate_entries_guard before update or delete on public.affiliate_entries
  for each row execute function public.affiliate_entries_guard();

create table if not exists public.affiliate_charges (
  charge_id    text primary key,
  tenant_id    uuid not null,
  member_id    uuid not null references public.human_members(id) on delete restrict,
  amount_cents integer not null check (amount_cents >= 0),
  livemode     boolean not null,
  card_fingerprint text check (card_fingerprint is null or length(card_fingerprint) <= 100),
  created_at   timestamptz not null default now()
);
create index if not exists affiliate_charges_member_fp_idx on public.affiliate_charges (member_id, card_fingerprint) where card_fingerprint is not null;

create table if not exists public.affiliate_refunds (
  charge_id      text primary key,
  refunded_cents integer not null check (refunded_cents >= 0),
  updated_at     timestamptz not null default now()
);

create table if not exists public.affiliate_credit_notes (
  id           text primary key,
  charge_id    text not null,
  amount_cents integer not null check (amount_cents >= 0),
  voided       boolean not null default false,
  updated_at   timestamptz not null default now()
);
create index if not exists affiliate_credit_notes_charge_idx on public.affiliate_credit_notes (charge_id);

create table if not exists public.affiliate_disputes (
  id           text primary key,
  charge_id    text not null,
  amount_cents integer not null check (amount_cents >= 0),
  status       text not null check (length(status) between 1 and 40),
  updated_at   timestamptz not null default now()
);
create index if not exists affiliate_disputes_charge_idx on public.affiliate_disputes (charge_id);

alter table public.affiliate_codes enable row level security;
alter table public.affiliate_clicks enable row level security;
alter table public.affiliate_referrals enable row level security;
alter table public.affiliate_payouts enable row level security;
alter table public.affiliate_reversals enable row level security;
alter table public.affiliate_entries enable row level security;
alter table public.affiliate_charges enable row level security;
alter table public.affiliate_refunds enable row level security;
alter table public.affiliate_credit_notes enable row level security;
alter table public.affiliate_disputes enable row level security;
alter table public.affiliate_event_inbox enable row level security;
alter table public.affiliate_event_inbox force row level security;
alter table public.affiliate_codes force row level security;
alter table public.affiliate_clicks force row level security;
alter table public.affiliate_referrals force row level security;
alter table public.affiliate_payouts force row level security;
alter table public.affiliate_reversals force row level security;
alter table public.affiliate_entries force row level security;
alter table public.affiliate_charges force row level security;
alter table public.affiliate_refunds force row level security;
alter table public.affiliate_credit_notes force row level security;
alter table public.affiliate_disputes force row level security;
revoke all on table public.affiliate_codes, public.affiliate_clicks, public.affiliate_referrals, public.affiliate_payouts,
  public.affiliate_reversals, public.affiliate_entries, public.affiliate_charges, public.affiliate_refunds,
  public.affiliate_credit_notes, public.affiliate_disputes, public.affiliate_event_inbox
  from public, anon, authenticated;
grant all on table public.affiliate_codes, public.affiliate_clicks, public.affiliate_referrals, public.affiliate_payouts,
  public.affiliate_reversals, public.affiliate_entries, public.affiliate_charges, public.affiliate_refunds,
  public.affiliate_credit_notes, public.affiliate_disputes, public.affiliate_event_inbox
  to service_role;

create or replace function public.affiliate_attribute(p_tenant_id uuid, p_click_id uuid, p_door text, p_signup_email text, p_user_id uuid)
returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_click  affiliate_clicks%rowtype;
  v_member uuid;
  v_auth   uuid;
  v_state  text;
  v_email  text;
begin
  if p_tenant_id is null or p_click_id is null or p_door not in ('activate', 'build_start', 'checkout') then
    raise exception 'affiliate_attribute: tenant, click and door are required' using errcode = '22023';
  end if;
  if exists (select 1 from affiliate_referrals where tenant_id = p_tenant_id) then
    return jsonb_build_object('outcome', 'already_attributed');
  end if;
  select * into v_click from affiliate_clicks where id = p_click_id;
  if v_click.id is null then return jsonb_build_object('outcome', 'unknown_click'); end if;
  if v_click.clicked_at < now() - interval '60 days' then return jsonb_build_object('outcome', 'expired'); end if;
  select c.member_id, m.auth_user_id, m.vetting_state into v_member, v_auth, v_state
    from affiliate_codes c join human_members m on m.id = c.member_id where c.code = v_click.code;
  if v_member is null or v_state <> 'approved' then return jsonb_build_object('outcome', 'not_eligible'); end if;
  if exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = v_auth) then
    return jsonb_build_object('outcome', 'self_referral');
  end if;
  if p_user_id is not null and exists (select 1 from tenant_users where user_id = p_user_id and tenant_id <> p_tenant_id) then
    return jsonb_build_object('outcome', 'existing_customer');
  end if;
  select lower(email) into v_email from auth.users where id = v_auth;
  if v_email is not null and lower(btrim(coalesce(p_signup_email, ''))) = v_email then
    return jsonb_build_object('outcome', 'self_referral');
  end if;
  insert into affiliate_referrals (tenant_id, member_id, code, click_id, clicked_at, door)
  values (p_tenant_id, v_member, v_click.code, v_click.id, v_click.clicked_at, p_door)
  on conflict (tenant_id) do nothing;
  if not found then return jsonb_build_object('outcome', 'already_attributed'); end if;
  return jsonb_build_object('outcome', 'attributed', 'member_id', v_member);
end $$;

create or replace function public.affiliate_reconcile_charge(p_charge_id text)
returns integer language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  c          affiliate_charges%rowtype;
  v_comm     bigint;
  v_adj      bigint;
  v_n        int;
  v_refunded bigint;
  v_credited bigint;
  v_disputed bigint;
  v_taken    bigint;
  v_target   bigint;
  v_delta    bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('affiliate_charge:' || p_charge_id, 0));
  select * into c from affiliate_charges where charge_id = p_charge_id;
  if c.charge_id is null then return 0; end if;
  perform pg_advisory_xact_lock(hashtextextended('affiliate_member:' || c.member_id::text, 0));
  select coalesce(sum(amount_cents) filter (where kind = 'commission'), 0),
         coalesce(sum(amount_cents) filter (where kind = 'adjustment'), 0),
         count(*) filter (where kind = 'adjustment')
    into v_comm, v_adj, v_n
    from affiliate_entries where charge_id = p_charge_id;
  if v_comm = 0 and v_adj = 0 then return 0; end if;
  select coalesce(max(refunded_cents), 0) into v_refunded from affiliate_refunds where charge_id = p_charge_id;
  select coalesce(sum(amount_cents), 0) into v_credited from affiliate_credit_notes where charge_id = p_charge_id and not voided;
  select coalesce(sum(amount_cents), 0) into v_disputed from affiliate_disputes
   where charge_id = p_charge_id and status in ('needs_response', 'under_review', 'lost');
  v_taken := least(c.amount_cents, v_refunded + v_credited + v_disputed);
  if c.amount_cents = 0 then
    v_target := 0;
  else
    v_target := floor(v_comm * (c.amount_cents - v_taken)::numeric / c.amount_cents);
  end if;
  v_delta := (v_target - v_comm) - v_adj;
  if v_delta = 0 then return 0; end if;
  insert into affiliate_entries (member_id, tenant_id, source_key, kind, amount_cents, charge_id, livemode, matures_at, payout_id)
  values (c.member_id, c.tenant_id, 'adj:' || p_charge_id || ':' || (v_n + 1), 'adjustment', v_delta, p_charge_id,
          c.livemode, now(),
          (select e.payout_id from affiliate_entries e join affiliate_payouts p on p.id = e.payout_id
            where e.charge_id = p_charge_id and e.kind = 'commission' and p.state = 'rejected' limit 1));
  if (select coalesce(sum(amount_cents), 0) from affiliate_entries
       where charge_id = p_charge_id and kind = 'adjustment' and payout_id is null) = 0 then
    update affiliate_entries set payout_id = (
             select e.payout_id from affiliate_entries e join affiliate_payouts p on p.id = e.payout_id
              where e.charge_id = p_charge_id and e.kind = 'commission' and p.state = 'sent' limit 1)
     where charge_id = p_charge_id and kind = 'adjustment' and payout_id is null
       and exists (select 1 from affiliate_entries e join affiliate_payouts p on p.id = e.payout_id
                    where e.charge_id = p_charge_id and e.kind = 'commission' and p.state = 'sent');
  end if;
  return v_delta;
end $$;

create or replace function public.affiliate_accrue(
  p_tenant_id uuid, p_charge_id text, p_charge_amount_cents integer, p_livemode boolean, p_card_fingerprint text,
  p_anchor timestamptz, p_entries jsonb
) returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  r       affiliate_referrals%rowtype;
  e       jsonb;
  v_added int := 0;
  v_same  boolean;
begin
  if p_tenant_id is null or nullif(p_charge_id, '') is null or p_charge_amount_cents is null or p_charge_amount_cents < 0
     or p_livemode is null or p_anchor is null or jsonb_typeof(p_entries) <> 'array' then
    raise exception 'affiliate_accrue: tenant, charge, amount, livemode, anchor and entries are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('affiliate_charge:' || p_charge_id, 0));
  select * into r from affiliate_referrals where tenant_id = p_tenant_id for update;
  if r.tenant_id is null then return jsonb_build_object('outcome', 'not_referred'); end if;
  perform pg_advisory_xact_lock(hashtextextended('affiliate_member:' || r.member_id::text, 0));
  if r.anchor_at is null then
    update affiliate_referrals set anchor_at = p_anchor where tenant_id = p_tenant_id;
  elsif r.anchor_at <> p_anchor then
    return jsonb_build_object('outcome', 'anchor_moved', 'anchor_at', r.anchor_at);
  end if;
  insert into affiliate_charges (charge_id, tenant_id, member_id, amount_cents, livemode, card_fingerprint)
  values (p_charge_id, p_tenant_id, r.member_id, p_charge_amount_cents, p_livemode, nullif(p_card_fingerprint, ''))
  on conflict (charge_id) do nothing;
  if nullif(p_card_fingerprint, '') is not null then
    select exists (select 1 from affiliate_charges where member_id = r.member_id and card_fingerprint = p_card_fingerprint
                    and tenant_id <> p_tenant_id) into v_same;
    if v_same then
      update affiliate_referrals set signals = signals || jsonb_build_object('card_seen_on_other_referral', true)
       where tenant_id = p_tenant_id;
    end if;
  end if;
  for e in select * from jsonb_array_elements(p_entries) loop
    insert into affiliate_entries (member_id, tenant_id, source_key, kind, amount_cents, charge_id, invoice_id,
                                   month_index, rate, base_cents, livemode, matures_at)
    values (r.member_id, p_tenant_id, e->>'source_key', 'commission', (e->>'amount_cents')::int, p_charge_id,
            e->>'invoice_id', (e->>'month_index')::int, (e->>'rate')::numeric, (e->>'base_cents')::int,
            p_livemode, (e->>'matures_at')::timestamptz)
    on conflict (source_key) do nothing;
    if found then v_added := v_added + 1; end if;
  end loop;
  perform affiliate_reconcile_charge(p_charge_id);
  return jsonb_build_object('outcome', 'accrued', 'added', v_added, 'member_id', r.member_id);
end $$;

create or replace function public.affiliate_refund(p_charge_id text, p_refunded_cents integer)
returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
begin
  if nullif(p_charge_id, '') is null or p_refunded_cents is null or p_refunded_cents < 0 then
    raise exception 'affiliate_refund: charge and amount are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('affiliate_charge:' || p_charge_id, 0));
  insert into affiliate_refunds (charge_id, refunded_cents) values (p_charge_id, p_refunded_cents)
  on conflict (charge_id) do update set refunded_cents = greatest(affiliate_refunds.refunded_cents, excluded.refunded_cents), updated_at = now();
  return jsonb_build_object('outcome', 'recorded', 'delta', affiliate_reconcile_charge(p_charge_id));
end $$;

create or replace function public.affiliate_credit_note(p_id text, p_charge_id text, p_amount_cents integer, p_voided boolean)
returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
begin
  if nullif(p_id, '') is null or nullif(p_charge_id, '') is null or p_amount_cents is null or p_amount_cents < 0 then
    raise exception 'affiliate_credit_note: id, charge and amount are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('affiliate_charge:' || p_charge_id, 0));
  insert into affiliate_credit_notes (id, charge_id, amount_cents, voided) values (p_id, p_charge_id, p_amount_cents, coalesce(p_voided, false))
  on conflict (id) do update set
    voided = affiliate_credit_notes.voided or excluded.voided,
    amount_cents = case when excluded.voided then affiliate_credit_notes.amount_cents else excluded.amount_cents end,
    updated_at = now();
  return jsonb_build_object('outcome', 'recorded', 'delta', affiliate_reconcile_charge(p_charge_id));
end $$;

create or replace function public.affiliate_dispute(p_id text, p_charge_id text, p_amount_cents integer, p_status text)
returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
begin
  if nullif(p_id, '') is null or nullif(p_charge_id, '') is null or p_amount_cents is null or p_amount_cents < 0
     or nullif(p_status, '') is null then
    raise exception 'affiliate_dispute: id, charge, amount and status are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('affiliate_charge:' || p_charge_id, 0));
  insert into affiliate_disputes (id, charge_id, amount_cents, status) values (p_id, p_charge_id, p_amount_cents, p_status)
  on conflict (id) do update set
    status = case when affiliate_disputes.status in ('won', 'lost', 'warning_closed', 'charge_refunded') then affiliate_disputes.status
                  else excluded.status end,
    amount_cents = case when affiliate_disputes.status in ('won', 'lost', 'warning_closed', 'charge_refunded') then affiliate_disputes.amount_cents
                        else excluded.amount_cents end,
    updated_at = now();
  return jsonb_build_object('outcome', 'recorded', 'delta', affiliate_reconcile_charge(p_charge_id));
end $$;

create or replace function public.affiliate_payout_claim(p_member_id uuid, p_min_cents integer, p_livemode boolean, p_now timestamptz default now())
returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_open   affiliate_payouts%rowtype;
  v_total  bigint;
  v_id     uuid;
  v_first  boolean;
begin
  if p_member_id is null or p_min_cents is null or p_min_cents < 1 or p_livemode is null then
    raise exception 'affiliate_payout_claim: member, a positive minimum and livemode are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('affiliate_member:' || p_member_id::text, 0));
  if not exists (select 1 from human_members where id = p_member_id and vetting_state = 'approved') then
    return jsonb_build_object('outcome', 'not_eligible');
  end if;
  if exists (select 1 from affiliate_payouts where member_id = p_member_id and livemode = p_livemode and state in ('transferring', 'reconcile')) then
    return jsonb_build_object('outcome', 'payout_in_flight');
  end if;
  if exists (select 1 from affiliate_reversals where member_id = p_member_id and livemode = p_livemode and state in ('claimed', 'reconcile')) then
    return jsonb_build_object('outcome', 'reversal_open');
  end if;
  select * into v_open from affiliate_payouts
   where member_id = p_member_id and livemode = p_livemode and state in ('awaiting_approval', 'claimed')
   order by created_at limit 1 for update;
  if v_open.id is not null then
    update affiliate_entries set payout_id = v_open.id
     where member_id = p_member_id and livemode = p_livemode and payout_id is null and (matures_at <= p_now or amount_cents < 0);
    select coalesce(sum(amount_cents), 0) into v_total from affiliate_entries where payout_id = v_open.id;
    if v_total < p_min_cents then
      update affiliate_payouts set state = 'cancelled', error = 'under the minimum after a refund', updated_at = now() where id = v_open.id;
      update affiliate_entries set payout_id = null where payout_id = v_open.id;
      return jsonb_build_object('outcome', 'cancelled', 'payout_id', v_open.id, 'total_cents', v_total);
    end if;
    update affiliate_payouts set amount_cents = v_total, updated_at = now() where id = v_open.id;
    return jsonb_build_object('outcome', v_open.state, 'payout_id', v_open.id, 'amount_cents', v_total, 'rebuilt', true);
  end if;
  select coalesce(sum(amount_cents), 0) into v_total from affiliate_entries
   where member_id = p_member_id and livemode = p_livemode and payout_id is null and (matures_at <= p_now or amount_cents < 0);
  if v_total < p_min_cents then return jsonb_build_object('outcome', 'below_minimum', 'total_cents', v_total); end if;
  v_first := not exists (select 1 from affiliate_payouts where member_id = p_member_id and livemode = p_livemode and state = 'sent');
  insert into affiliate_payouts (member_id, livemode, amount_cents, state)
  values (p_member_id, p_livemode, v_total, case when v_first then 'awaiting_approval' else 'claimed' end)
  returning id into v_id;
  update affiliate_entries set payout_id = v_id
   where member_id = p_member_id and livemode = p_livemode and payout_id is null and (matures_at <= p_now or amount_cents < 0);
  return jsonb_build_object('outcome', case when v_first then 'awaiting_approval' else 'claimed' end, 'payout_id', v_id, 'amount_cents', v_total);
end $$;

create or replace function public.affiliate_payout_start(p_payout_id uuid, p_min_cents integer, p_destination text, p_now timestamptz default now())
returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v affiliate_payouts%rowtype;
  v_total bigint;
begin
  select * into v from affiliate_payouts where id = p_payout_id;
  if v.id is null then return jsonb_build_object('outcome', 'not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended('affiliate_member:' || v.member_id::text, 0));
  select * into v from affiliate_payouts where id = p_payout_id for update;
  if v.state <> 'claimed' then return jsonb_build_object('outcome', 'wrong_state', 'state', v.state); end if;
  if exists (select 1 from affiliate_reversals where member_id = v.member_id and livemode = v.livemode and state in ('claimed', 'reconcile')) then
    return jsonb_build_object('outcome', 'reversal_open');
  end if;
  update affiliate_entries set payout_id = v.id
   where member_id = v.member_id and livemode = v.livemode and payout_id is null and (matures_at <= p_now or amount_cents < 0);
  select coalesce(sum(amount_cents), 0) into v_total from affiliate_entries where payout_id = v.id;
  if v_total < p_min_cents or not exists (select 1 from human_members where id = v.member_id and vetting_state = 'approved') then
    update affiliate_payouts set state = 'cancelled',
      error = case when v_total < p_min_cents then 'under the minimum at send' else 'creator not approved' end, updated_at = now()
     where id = v.id;
    update affiliate_entries set payout_id = null where payout_id = v.id;
    return jsonb_build_object('outcome', 'cancelled');
  end if;
  if p_destination is null or p_destination !~ '^acct_[A-Za-z0-9]+$' then
    raise exception 'affiliate_payout_start: a destination account is required' using errcode = '22023';
  end if;
  update affiliate_payouts set state = 'transferring', amount_cents = v_total, first_attempt_at = coalesce(first_attempt_at, now()),
    destination_account = coalesce(destination_account, p_destination), updated_at = now() where id = v.id;
  return jsonb_build_object('outcome', 'transferring', 'amount_cents', v_total);
end $$;

create or replace function public.affiliate_members_to_visit(p_livemode boolean, p_after uuid, p_limit integer, p_now timestamptz default now())
returns setof uuid language sql stable security invoker set search_path = public, pg_temp as $$
  select member_id from (
    select distinct member_id from affiliate_entries
     where payout_id is null and livemode = p_livemode and (matures_at <= p_now or amount_cents < 0)
       and member_id > coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
    union
    select distinct member_id from affiliate_payouts
     where livemode = p_livemode and state in ('awaiting_approval', 'claimed')
       and member_id > coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
  ) m order by member_id limit greatest(1, least(p_limit, 1000));
$$;

create or replace function public.affiliate_payout_move(p_payout_id uuid, p_from text, p_to text, p_transfer_id text, p_error text, p_actor uuid)
returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_state  text;
  v_member uuid;
begin
  select state, member_id into v_state, v_member from affiliate_payouts where id = p_payout_id;
  if v_state is null then return jsonb_build_object('outcome', 'not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended('affiliate_member:' || v_member::text, 0));
  select state into v_state from affiliate_payouts where id = p_payout_id for update;
  if v_state <> p_from then return jsonb_build_object('outcome', 'wrong_state', 'state', v_state); end if;
  if not ((p_from = 'awaiting_approval' and p_to in ('claimed', 'rejected', 'cancelled'))
       or (p_from = 'claimed' and p_to in ('transferring', 'failed', 'cancelled'))
       or (p_from = 'transferring' and p_to in ('sent', 'failed', 'reconcile'))
       or (p_from = 'reconcile' and p_to in ('sent', 'failed'))) then
    raise exception 'affiliate_payout_move: % -> % is not allowed', p_from, p_to using errcode = '22023';
  end if;
  if p_to = 'sent' and nullif(p_transfer_id, '') is null then
    raise exception 'affiliate_payout_move: a sent payout needs its transfer id' using errcode = '22023';
  end if;
  update affiliate_payouts set
    state = p_to,
    stripe_transfer_id = coalesce(nullif(p_transfer_id, ''), stripe_transfer_id),
    error = coalesce(left(p_error, 300), error),
    approved_by = case when p_from = 'awaiting_approval' then p_actor else approved_by end,
    updated_at = now()
  where id = p_payout_id;
  if p_to in ('failed', 'cancelled') then
    update affiliate_entries set payout_id = null where payout_id = p_payout_id;
  end if;
  return jsonb_build_object('outcome', 'moved', 'state', p_to);
end $$;

create or replace function public.affiliate_payout_owed(p_payout_id uuid)
returns bigint language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce((select -sum(a.amount_cents) from affiliate_entries a
                    where a.payout_id is null and a.kind = 'adjustment'
                      and a.charge_id in (select c.charge_id from affiliate_entries c where c.payout_id = p_payout_id and c.kind = 'commission')), 0)
       - coalesce((select sum(e.amount_cents) from affiliate_entries e
                     join affiliate_reversals r on e.source_key = 'recovered:' || r.id
                    where r.payout_id = p_payout_id and e.payout_id is null), 0);
$$;

create or replace function public.affiliate_payout_room(p_payout_id uuid, p_except uuid)
returns bigint language sql stable security invoker set search_path = public, pg_temp as $$
  select p.amount_cents - coalesce((select sum(amount_cents) from affiliate_reversals r
                                     where r.payout_id = p.id and r.state in ('claimed', 'sent', 'reconcile')
                                       and r.id is distinct from p_except), 0)
    from affiliate_payouts p where p.id = p_payout_id;
$$;

create or replace function public.affiliate_reversal_claim(p_member_id uuid, p_livemode boolean)
returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_open   affiliate_reversals%rowtype;
  v_pay    record;
  v_amount bigint;
  v_id     uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('affiliate_member:' || p_member_id::text, 0));
  select * into v_open from affiliate_reversals
   where member_id = p_member_id and livemode = p_livemode and state in ('claimed', 'reconcile') limit 1;
  if v_open.id is not null then
    return jsonb_build_object('outcome', 'open', 'reversal_id', v_open.id, 'payout_id', v_open.payout_id,
      'transfer_id', (select stripe_transfer_id from affiliate_payouts where id = v_open.payout_id),
      'amount_cents', v_open.amount_cents, 'state', v_open.state, 'attempted_at', v_open.attempted_at);
  end if;
  for v_pay in
    select p.id, p.stripe_transfer_id
      from affiliate_payouts p
     where p.member_id = p_member_id and p.livemode = p_livemode and p.state = 'sent'
       and affiliate_payout_owed(p.id) > 0
     order by p.created_at desc
  loop
    v_amount := least(affiliate_payout_owed(v_pay.id), affiliate_payout_room(v_pay.id, null));
    if v_amount > 0 then
      insert into affiliate_reversals (member_id, payout_id, livemode, amount_cents, state)
      values (p_member_id, v_pay.id, p_livemode, v_amount, 'claimed')
      returning id into v_id;
      return jsonb_build_object('outcome', 'claimed', 'reversal_id', v_id, 'payout_id', v_pay.id, 'transfer_id', v_pay.stripe_transfer_id,
        'amount_cents', v_amount, 'state', 'claimed');
    end if;
  end loop;
  return jsonb_build_object('outcome', 'no_debt');
end $$;

create or replace function public.affiliate_reversal_start(p_id uuid)
returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v affiliate_reversals%rowtype;
  v_amount bigint;
begin
  select * into v from affiliate_reversals where id = p_id;
  if v.id is null then return jsonb_build_object('outcome', 'not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended('affiliate_member:' || v.member_id::text, 0));
  select * into v from affiliate_reversals where id = p_id for update;
  if v.state <> 'claimed' then return jsonb_build_object('outcome', 'wrong_state', 'state', v.state); end if;
  v_amount := least(affiliate_payout_owed(v.payout_id), affiliate_payout_room(v.payout_id, v.id));
  if v_amount <= 0 then
    update affiliate_reversals set state = 'failed', error = 'nothing owed any more', updated_at = now() where id = p_id;
    return jsonb_build_object('outcome', 'cancelled');
  end if;
  update affiliate_reversals set state = 'reconcile', amount_cents = v_amount, attempted_at = coalesce(attempted_at, now()), updated_at = now()
   where id = p_id;
  return jsonb_build_object('outcome', 'reconcile', 'amount_cents', v_amount);
end $$;

create or replace function public.affiliate_reversal_external(p_payout_id uuid, p_stripe_reversal_id text, p_amount_cents integer)
returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  p affiliate_payouts%rowtype;
  v_id uuid;
begin
  if nullif(p_stripe_reversal_id, '') is null or p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'affiliate_reversal_external: reversal id and a positive amount are required' using errcode = '22023';
  end if;
  select * into p from affiliate_payouts where id = p_payout_id;
  if p.id is null or p.state <> 'sent' then return jsonb_build_object('outcome', 'not_sent'); end if;
  perform pg_advisory_xact_lock(hashtextextended('affiliate_member:' || p.member_id::text, 0));
  if exists (select 1 from affiliate_reversals where stripe_reversal_id = p_stripe_reversal_id) then
    return jsonb_build_object('outcome', 'already_recorded');
  end if;
  if exists (select 1 from affiliate_reversals where payout_id = p.id and state = 'reconcile'
              and coalesce(attempted_at, now()) > now() - interval '1 hour') then
    return jsonb_build_object('outcome', 'reversal_in_flight');
  end if;
  update affiliate_reversals set state = 'failed', error = 'superseded by a dashboard reversal recorded by staff', updated_at = now()
   where payout_id = p.id and state in ('claimed', 'reconcile');
  insert into affiliate_reversals (member_id, payout_id, livemode, amount_cents, state, stripe_reversal_id, attempted_at, error)
  values (p.member_id, p.id, p.livemode, p_amount_cents, 'sent', p_stripe_reversal_id, now(), 'recorded by staff from the Stripe dashboard')
  returning id into v_id;
  insert into affiliate_entries (member_id, source_key, kind, amount_cents, livemode, matures_at)
  values (p.member_id, 'recovered:' || v_id, 'recovered', p_amount_cents, p.livemode, now());
  return jsonb_build_object('outcome', 'recorded', 'reversal_id', v_id);
end $$;

create or replace function public.affiliate_reversal_move(p_id uuid, p_from text, p_to text, p_stripe_id text, p_error text)
returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v affiliate_reversals%rowtype;
begin
  select * into v from affiliate_reversals where id = p_id;
  if v.id is null then return jsonb_build_object('outcome', 'not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended('affiliate_member:' || v.member_id::text, 0));
  select * into v from affiliate_reversals where id = p_id for update;
  if v.state <> p_from then return jsonb_build_object('outcome', 'wrong_state', 'state', v.state); end if;
  if not ((p_from = 'claimed' and p_to in ('sent', 'failed', 'reconcile')) or (p_from = 'reconcile' and p_to in ('sent', 'failed'))) then
    raise exception 'affiliate_reversal_move: % -> % is not allowed', p_from, p_to using errcode = '22023';
  end if;
  if p_to = 'sent' and nullif(p_stripe_id, '') is null then
    raise exception 'affiliate_reversal_move: a sent reversal needs its Stripe id' using errcode = '22023';
  end if;
  update affiliate_reversals set state = p_to, stripe_reversal_id = coalesce(nullif(p_stripe_id, ''), stripe_reversal_id),
    attempted_at = case when p_to = 'reconcile' then coalesce(attempted_at, now()) else attempted_at end,
    error = coalesce(left(p_error, 300), error), updated_at = now() where id = p_id;
  if p_to = 'sent' then
    insert into affiliate_entries (member_id, source_key, kind, amount_cents, livemode, matures_at)
    values (v.member_id, 'recovered:' || p_id, 'recovered', v.amount_cents, v.livemode, now())
    on conflict (source_key) do nothing;
  end if;
  return jsonb_build_object('outcome', 'moved', 'state', p_to);
end $$;

create or replace function public.affiliate_inbox_fail(p_event_id text, p_error text)
returns boolean language sql volatile security invoker set search_path = public, pg_temp as $$
  update affiliate_event_inbox set attempts = attempts + 1, dead = (attempts + 1) >= 5, last_error = left(p_error, 300)
   where event_id = p_event_id
  returning dead;
$$;

create or replace function public.affiliate_purge_clicks(p_before timestamptz, p_limit integer)
returns integer language sql volatile security invoker set search_path = public, pg_temp as $$
  with gone as (
    delete from affiliate_clicks where id in (
      select id from affiliate_clicks where clicked_at < p_before order by clicked_at limit greatest(1, least(p_limit, 10000)))
    returning 1)
  select count(*)::int from gone;
$$;

create or replace function public.affiliate_member_totals(p_member_id uuid, p_livemode boolean, p_now timestamptz default now())
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  with e as (
    select e.amount_cents, e.payout_id, e.matures_at, p.state as pstate
      from affiliate_entries e left join affiliate_payouts p on p.id = e.payout_id
     where e.member_id = p_member_id and e.livemode = p_livemode and coalesce(p.state, '') <> 'rejected'
  )
  select jsonb_build_object(
    'pending_cents', coalesce((select sum(amount_cents) from e where payout_id is null and matures_at > p_now and amount_cents > 0), 0),
    'payable_cents', coalesce((select sum(amount_cents) from e where (payout_id is null and (matures_at <= p_now or amount_cents < 0))
                                                              or pstate in ('awaiting_approval', 'claimed', 'transferring', 'reconcile')), 0),
    'paid_cents',    coalesce((select sum(amount_cents) from e where pstate = 'sent'), 0)
                   - coalesce((select sum(amount_cents) from affiliate_reversals
                                where member_id = p_member_id and livemode = p_livemode and state = 'sent'), 0),
    'paying',        (select count(*) from (select tenant_id from affiliate_entries
                       where member_id = p_member_id and livemode = p_livemode and kind in ('commission', 'adjustment') and tenant_id is not null
                       group by tenant_id having sum(amount_cents) > 0) t),
    'signups',       (select count(*) from affiliate_referrals where member_id = p_member_id)
  );
$$;

revoke all on function public.affiliate_attribute(uuid, uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.affiliate_reconcile_charge(text) from public, anon, authenticated;
revoke all on function public.affiliate_accrue(uuid, text, integer, boolean, text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.affiliate_refund(text, integer) from public, anon, authenticated;
revoke all on function public.affiliate_credit_note(text, text, integer, boolean) from public, anon, authenticated;
revoke all on function public.affiliate_dispute(text, text, integer, text) from public, anon, authenticated;
revoke all on function public.affiliate_payout_claim(uuid, integer, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.affiliate_payout_move(uuid, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.affiliate_reversal_claim(uuid, boolean) from public, anon, authenticated;
revoke all on function public.affiliate_reversal_start(uuid) from public, anon, authenticated;
revoke all on function public.affiliate_reversal_external(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.affiliate_payout_owed(uuid) from public, anon, authenticated;
revoke all on function public.affiliate_payout_room(uuid, uuid) from public, anon, authenticated;
revoke all on function public.affiliate_reversal_move(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.affiliate_member_totals(uuid, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.affiliate_payout_start(uuid, integer, text, timestamptz) from public, anon, authenticated;
revoke all on function public.affiliate_inbox_fail(text, text) from public, anon, authenticated;
revoke all on function public.affiliate_purge_clicks(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.affiliate_members_to_visit(boolean, uuid, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.affiliate_entries_guard() from public, anon, authenticated;
grant execute on function public.affiliate_attribute(uuid, uuid, text, text, uuid) to service_role;
grant execute on function public.affiliate_reconcile_charge(text) to service_role;
grant execute on function public.affiliate_accrue(uuid, text, integer, boolean, text, timestamptz, jsonb) to service_role;
grant execute on function public.affiliate_refund(text, integer) to service_role;
grant execute on function public.affiliate_credit_note(text, text, integer, boolean) to service_role;
grant execute on function public.affiliate_dispute(text, text, integer, text) to service_role;
grant execute on function public.affiliate_payout_claim(uuid, integer, boolean, timestamptz) to service_role;
grant execute on function public.affiliate_payout_move(uuid, text, text, text, text, uuid) to service_role;
grant execute on function public.affiliate_reversal_claim(uuid, boolean) to service_role;
grant execute on function public.affiliate_reversal_start(uuid) to service_role;
grant execute on function public.affiliate_reversal_external(uuid, text, integer) to service_role;
grant execute on function public.affiliate_payout_owed(uuid) to service_role;
grant execute on function public.affiliate_payout_room(uuid, uuid) to service_role;
grant execute on function public.affiliate_reversal_move(uuid, text, text, text, text) to service_role;
grant execute on function public.affiliate_member_totals(uuid, boolean, timestamptz) to service_role;
grant execute on function public.affiliate_payout_start(uuid, integer, text, timestamptz) to service_role;
grant execute on function public.affiliate_inbox_fail(text, text) to service_role;
grant execute on function public.affiliate_purge_clicks(timestamptz, integer) to service_role;
grant execute on function public.affiliate_members_to_visit(boolean, uuid, integer, timestamptz) to service_role;
