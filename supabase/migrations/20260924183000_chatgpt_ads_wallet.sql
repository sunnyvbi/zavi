begin;
create table public.ads_wallets (
 tenant_id uuid primary key references public.tenants(id) on delete cascade,
 balance_cents bigint not null default 0,
 stripe_customer_id text unique,
 payment_method_id text,
 auto_refill_enabled boolean not null default false,
 refill_cents integer not null default 10000 check (refill_cents between 100 and 500000),
 threshold_cents integer not null default 5000 check (threshold_cents = 5000),
 setup_request_id uuid,
 pending_refill_id uuid,
 consent_at timestamptz,
 consent_user_id uuid,
 last_error text,
 updated_at timestamptz not null default now()
);
create table public.ads_wallet_orders (
 id uuid primary key,
 tenant_id uuid not null references public.ads_wallets(tenant_id),
 kind text not null check (kind in ('topup','refill','setup')),
 amount_cents integer not null check (amount_cents between 100 and 500000),
 payment_intent_id text unique,
 credited_cents bigint not null default 0,
 last_event_created bigint not null default 0,
 status text not null default 'pending' check (status in ('pending','paid','failed')),
 created_at timestamptz not null default now()
);
create table public.ads_campaign_funding (
 campaign_id text primary key,
 tenant_id uuid not null references public.ads_wallets(tenant_id),
 reserved_cents bigint not null default 0 check (reserved_cents >= 0),
 spent_cents bigint not null default 0 check (spent_cents >= 0),
 baseline_cents bigint not null default 0 check (baseline_cents >= 0),
 updated_at timestamptz not null default now()
);
create index on public.ads_wallet_orders(tenant_id);
create index on public.ads_campaign_funding(tenant_id);
alter table public.ads_wallets enable row level security;
alter table public.ads_wallet_orders enable row level security;
alter table public.ads_campaign_funding enable row level security;
revoke all on public.ads_wallets, public.ads_wallet_orders, public.ads_campaign_funding from public, anon, authenticated;
grant all on public.ads_wallets, public.ads_wallet_orders, public.ads_campaign_funding to service_role;

create function public.ads_wallet_apply_payment(p_order_id uuid, p_payment_intent_id text, p_net_cents bigint, p_event_created bigint)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare o ads_wallet_orders%rowtype;
begin
 select * into o from ads_wallet_orders where id=p_order_id for update;
 if not found or o.kind='setup' then raise exception 'unknown ads payment'; end if;
 if p_event_created<o.last_event_created or (p_event_created=o.last_event_created and p_net_cents>o.credited_cents) then return; end if;
 if p_net_cents<0 or p_net_cents>o.amount_cents then raise exception 'invalid ads payment amount'; end if;
 if o.payment_intent_id is not null and o.payment_intent_id<>p_payment_intent_id then raise exception 'ads payment conflict'; end if;
 perform 1 from ads_wallets where tenant_id=o.tenant_id for update;
 update ads_wallets set balance_cents=balance_cents+p_net_cents-o.credited_cents,
 pending_refill_id=case when pending_refill_id=o.id then null else pending_refill_id end,
 updated_at=now() where tenant_id=o.tenant_id;
 update ads_wallet_orders set payment_intent_id=p_payment_intent_id, credited_cents=p_net_cents,last_event_created=p_event_created,status='paid' where id=o.id;
end $$;

create function public.ads_wallet_reserve(p_tenant_id uuid,p_campaign_id text,p_lifetime_cents bigint,p_observed_spend_cents bigint)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare w ads_wallets%rowtype; f ads_campaign_funding%rowtype; other_reserved bigint; need bigint;
begin
 if p_lifetime_cents<0 or p_observed_spend_cents<0 then raise exception 'invalid ads reservation'; end if;
 select * into w from ads_wallets where tenant_id=p_tenant_id for update;
 if not found then raise exception 'ads_balance_insufficient'; end if;
 select * into f from ads_campaign_funding where campaign_id=p_campaign_id;
 if found and f.tenant_id<>p_tenant_id then raise exception 'campaign ownership conflict'; end if;
 if f.campaign_id is null then
  insert into ads_campaign_funding(campaign_id,tenant_id,spent_cents,baseline_cents) values(p_campaign_id,p_tenant_id,p_observed_spend_cents,p_observed_spend_cents);
  f.spent_cents:=p_observed_spend_cents; f.reserved_cents:=0;
 end if;
 if p_observed_spend_cents>f.spent_cents then
  w.balance_cents:=w.balance_cents-(p_observed_spend_cents-f.spent_cents);
  f.reserved_cents:=greatest(0,f.reserved_cents-(p_observed_spend_cents-f.spent_cents));
  f.spent_cents:=p_observed_spend_cents;
 end if;
 select coalesce(sum(reserved_cents),0) into other_reserved from ads_campaign_funding where tenant_id=p_tenant_id and campaign_id<>p_campaign_id;
 need:=greatest(f.reserved_cents,p_lifetime_cents-f.spent_cents,0);
 if w.balance_cents-other_reserved<need then raise exception 'ads_balance_insufficient'; end if;
 update ads_wallets set balance_cents=w.balance_cents,updated_at=now() where tenant_id=p_tenant_id;
 update ads_campaign_funding set reserved_cents=need,spent_cents=f.spent_cents,updated_at=now() where campaign_id=p_campaign_id;
end $$;

create function public.ads_wallet_settle_spend(p_tenant_id uuid,p_campaign_id text,p_spend_cents bigint)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare f ads_campaign_funding%rowtype; delta bigint;
begin
 if p_spend_cents<0 then raise exception 'invalid spend'; end if;
 perform 1 from ads_wallets where tenant_id=p_tenant_id for update;
 select * into f from ads_campaign_funding where tenant_id=p_tenant_id and campaign_id=p_campaign_id for update;
 if not found then return; end if;
 delta:=greatest(0,p_spend_cents-f.spent_cents);
 update ads_wallets set balance_cents=balance_cents-delta,updated_at=now() where tenant_id=p_tenant_id;
 update ads_campaign_funding set spent_cents=greatest(spent_cents,p_spend_cents), reserved_cents=greatest(0,reserved_cents-delta),updated_at=now() where campaign_id=p_campaign_id;
end $$;

create function public.ads_wallet_claim_refill(p_tenant_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare w ads_wallets%rowtype; rid uuid;
begin
 select * into w from ads_wallets where tenant_id=p_tenant_id for update;
 if not found or not w.auto_refill_enabled or w.payment_method_id is null then return null; end if;
 if w.pending_refill_id is not null then return w.pending_refill_id; end if;
 if w.balance_cents>=w.threshold_cents then return null; end if;
 rid:=gen_random_uuid();
 insert into ads_wallet_orders(id,tenant_id,kind,amount_cents) values(rid,p_tenant_id,'refill',w.refill_cents);
 update ads_wallets set pending_refill_id=rid,updated_at=now() where tenant_id=p_tenant_id;
 return rid;
end $$;

revoke all on function public.ads_wallet_apply_payment(uuid,text,bigint,bigint) from public,anon,authenticated;
revoke all on function public.ads_wallet_reserve(uuid,text,bigint,bigint) from public,anon,authenticated;
revoke all on function public.ads_wallet_settle_spend(uuid,text,bigint) from public,anon,authenticated;
revoke all on function public.ads_wallet_claim_refill(uuid) from public,anon,authenticated;
grant execute on function public.ads_wallet_apply_payment(uuid,text,bigint,bigint), public.ads_wallet_reserve(uuid,text,bigint,bigint), public.ads_wallet_settle_spend(uuid,text,bigint), public.ads_wallet_claim_refill(uuid) to service_role;
commit;
