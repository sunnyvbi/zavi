
create table if not exists startup_offer (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  max_redemptions int  not null check (max_redemptions >= 0),
  credits         int  not null check (credits > 0 and credits <= 100000),
  price_cents     int  not null check (price_cents > 0),
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

comment on column startup_offer.credits is
  'Credits granted per redemption. Capped at 100000 because grant_promo_credits '
  'hard-caps a single grant at 100000 (20260710205811); a larger value here '
  'would fail at grant time AFTER the customer was charged.';

create table if not exists startup_offer_claim (
  id             uuid primary key default gen_random_uuid(),
  offer_id       uuid not null references startup_offer(id) on delete cascade,
  tenant_id      uuid not null references tenants(id) on delete cascade,
  user_id        uuid not null,
  state          text not null default 'pending'
                 check (state in ('pending','paid','granted','refunded','expired')),
  payment_intent text,
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists startup_offer_claim_tenant_live_uq
  on startup_offer_claim (offer_id, tenant_id)
  where state in ('pending','paid','granted');
create unique index if not exists startup_offer_claim_user_live_uq
  on startup_offer_claim (offer_id, user_id)
  where state in ('pending','paid','granted');
create unique index if not exists startup_offer_claim_pi_uq
  on startup_offer_claim (payment_intent)
  where payment_intent is not null;

alter table startup_offer         enable row level security;
alter table startup_offer_claim   enable row level security;

create or replace function claim_startup_seat(
  p_offer_slug  text,
  p_tenant_id   uuid,
  p_user_id     uuid,
  p_ttl_minutes int default 30
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_offer  startup_offer%rowtype;
  v_used   int;
  v_claim  uuid;
begin
  select * into v_offer from startup_offer
   where slug = p_offer_slug for update;
  if not found then
    raise exception 'startup_offer_not_found' using errcode = 'P0002';
  end if;
  if not v_offer.active then
    raise exception 'startup_offer_inactive' using errcode = 'P0001';
  end if;

  update startup_offer_claim
     set state = 'expired', updated_at = now()
   where offer_id = v_offer.id
     and state = 'pending'
     and expires_at <= now();

  select count(*) into v_used
    from startup_offer_claim
   where offer_id = v_offer.id
     and (state in ('paid','granted')
          or (state = 'pending' and expires_at > now()));

  if v_used >= v_offer.max_redemptions then
    raise exception 'startup_offer_sold_out' using errcode = 'P0001';
  end if;

  select id into v_claim from startup_offer_claim
   where offer_id = v_offer.id
     and state in ('pending','paid','granted')
     and (tenant_id = p_tenant_id or user_id = p_user_id)
   limit 1;
  if v_claim is not null then
    return v_claim;
  end if;

  insert into startup_offer_claim (offer_id, tenant_id, user_id, expires_at)
  values (v_offer.id, p_tenant_id, p_user_id,
          now() + make_interval(mins => greatest(p_ttl_minutes, 1)))
  returning id into v_claim;

  return v_claim;
end $$;

create or replace function attach_startup_claim_payment(
  p_tenant_id      uuid,
  p_claim_id       uuid,
  p_payment_intent text
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update startup_offer_claim
     set payment_intent = p_payment_intent, updated_at = now()
   where id = p_claim_id and tenant_id = p_tenant_id and state = 'pending';
  return found;
end $$;

create or replace function settle_startup_claim(
  p_payment_intent text,
  p_grant_key      text,
  p_actor_email    text default 'stripe-webhook'
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claim  startup_offer_claim%rowtype;
  v_offer  startup_offer%rowtype;
begin
  select * into v_claim from startup_offer_claim
   where payment_intent = p_payment_intent for update;
  if not found then
    return 'not_found';
  end if;
  if v_claim.state = 'refunded' then
    return 'refused_refunded';
  end if;
  if v_claim.state = 'granted' then
    return 'already_granted';
  end if;

  select * into v_offer from startup_offer where id = v_claim.offer_id;

  perform grant_promo_credits(
    v_claim.tenant_id, v_offer.credits,
    'startup offer ' || v_offer.slug, p_grant_key, p_actor_email);

  update startup_offer_claim
     set state = 'granted', updated_at = now()
   where id = v_claim.id;

  return 'granted';
end $$;

create or replace function tombstone_startup_claim(
  p_payment_intent text,
  p_grant_key      text,
  p_reason         text default 'refund'
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claim   startup_offer_claim%rowtype;
  v_had     boolean;
begin
  select * into v_claim from startup_offer_claim
   where payment_intent = p_payment_intent for update;
  if not found then
    return 'not_found';
  end if;

  update startup_offer_claim
     set state = 'refunded', updated_at = now()
   where id = v_claim.id;

  select exists(
    select 1 from tenant_credit_ledger
     where kind = 'grant' and grant_key = p_grant_key
  ) into v_had;

  if v_had then
    perform revoke_promo_credits(p_grant_key, p_reason);
    return 'tombstoned_and_revoked';
  end if;

  return 'tombstoned_no_grant';
end $$;

create or replace function startup_offer_status(p_offer_slug text)
returns json language sql stable security definer set search_path = public, pg_temp as $$
  select json_build_object(
    'slug',            o.slug,
    'active',          o.active,
    'credits',         o.credits,
    'price_cents',     o.price_cents,
    'seats_total',     o.max_redemptions,
    'seats_remaining', greatest(0, o.max_redemptions - coalesce(u.used, 0)),
    'sold_out',        coalesce(u.used, 0) >= o.max_redemptions
  )
  from startup_offer o
  left join lateral (
    select count(*)::int as used
      from startup_offer_claim c
     where c.offer_id = o.id
       and (c.state in ('paid','granted')
            or (c.state = 'pending' and c.expires_at > now()))
  ) u on true
  where o.slug = p_offer_slug;
$$;

revoke all on function startup_offer_status(text) from public;
grant execute on function startup_offer_status(text) to anon, authenticated, service_role;

revoke all on function claim_startup_seat(text, uuid, uuid, int)      from public, anon, authenticated;
revoke all on function attach_startup_claim_payment(uuid, uuid, text) from public, anon, authenticated;
revoke all on function settle_startup_claim(text, text, text)         from public, anon, authenticated;
revoke all on function tombstone_startup_claim(text, text, text)      from public, anon, authenticated;
grant execute on function claim_startup_seat(text, uuid, uuid, int)   to service_role;
grant execute on function attach_startup_claim_payment(uuid, uuid, text) to service_role;
grant execute on function settle_startup_claim(text, text, text)      to service_role;
grant execute on function tombstone_startup_claim(text, text, text)   to service_role;

revoke all on table startup_offer, startup_offer_claim from public, anon, authenticated;

insert into startup_offer (slug, max_redemptions, credits, price_cents, active)
values ('launch-2026', 100, 100000, 100, true)
on conflict (slug) do nothing;
