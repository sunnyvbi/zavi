begin;
alter table public.ads_wallet_orders drop constraint ads_wallet_orders_tenant_id_fkey;
alter table public.ads_wallet_orders add constraint ads_wallet_orders_tenant_id_fkey
 foreign key (tenant_id) references public.ads_wallets(tenant_id) on delete cascade;
alter table public.ads_campaign_funding drop constraint ads_campaign_funding_tenant_id_fkey;
alter table public.ads_campaign_funding add constraint ads_campaign_funding_tenant_id_fkey
 foreign key (tenant_id) references public.ads_wallets(tenant_id) on delete cascade;

alter table public.ads_wallet_orders add column refill_day date;
update public.ads_wallet_orders set refill_day=(created_at at time zone 'UTC')::date where kind='refill';
create index ads_wallet_refill_day_idx on public.ads_wallet_orders(tenant_id, refill_day) where kind='refill';

create or replace function public.ads_wallet_apply_payment(p_order_id uuid, p_payment_intent_id text, p_net_cents bigint, p_event_created bigint)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare o ads_wallet_orders%rowtype;
begin
 select * into o from ads_wallet_orders where id=p_order_id;
 if not found then raise exception 'unknown ads payment'; end if;
 perform 1 from ads_wallets where tenant_id=o.tenant_id for update;
 select * into o from ads_wallet_orders where id=p_order_id for update;
 if not found or o.kind='setup' then raise exception 'unknown ads payment'; end if;
 if p_event_created<o.last_event_created or (p_event_created=o.last_event_created and p_net_cents>o.credited_cents) then return; end if;
 if p_net_cents<0 or p_net_cents>o.amount_cents then raise exception 'invalid ads payment amount'; end if;
 if o.payment_intent_id is not null and o.payment_intent_id<>p_payment_intent_id then raise exception 'ads payment conflict'; end if;
 update ads_wallets set balance_cents=balance_cents+p_net_cents-o.credited_cents,
 auto_refill_enabled=case when p_net_cents<o.amount_cents then false else auto_refill_enabled end,
 setup_request_id=case when p_net_cents<o.amount_cents then null else setup_request_id end,
 pending_refill_id=case when pending_refill_id=o.id then null else pending_refill_id end,
 updated_at=now() where tenant_id=o.tenant_id;
 update ads_wallet_orders set payment_intent_id=p_payment_intent_id, credited_cents=p_net_cents,last_event_created=p_event_created,status='paid' where id=o.id;
end $$;

create or replace function public.ads_wallet_claim_refill(p_tenant_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare w ads_wallets%rowtype; o ads_wallet_orders%rowtype; rid uuid;
 today date := (now() at time zone 'UTC')::date; committed bigint;
begin
 select * into w from ads_wallets where tenant_id=p_tenant_id for update;
 if not found or not w.auto_refill_enabled or w.payment_method_id is null then return null; end if;
 if w.pending_refill_id is not null then
  select * into o from ads_wallet_orders where id=w.pending_refill_id and tenant_id=p_tenant_id and kind='refill' for update;
  if not found or o.status<>'pending' then return null; end if;
 elsif w.balance_cents>=w.threshold_cents then return null;
 end if;
 select coalesce(sum(amount_cents),0) into committed from ads_wallet_orders
 where tenant_id=p_tenant_id and kind='refill'
 and (refill_day=today or (created_at at time zone 'UTC')::date=today);
 if committed+(case when o.refill_day=today then 0 else coalesce(o.amount_cents,w.refill_cents) end)>100000 then
  update ads_wallets set last_error='The $1,000 daily auto-refill limit has been reached. Automatic refills resume after midnight UTC.',updated_at=now() where tenant_id=p_tenant_id;
  return null;
 end if;
 if o.id is not null then
  update ads_wallet_orders set refill_day=today where id=o.id;
  return o.id;
 end if;
 rid:=gen_random_uuid();
 insert into ads_wallet_orders(id,tenant_id,kind,amount_cents,refill_day) values(rid,p_tenant_id,'refill',w.refill_cents,today);
 update ads_wallets set pending_refill_id=rid,last_error=null,updated_at=now() where tenant_id=p_tenant_id;
 return rid;
end $$;
revoke all on function public.ads_wallet_apply_payment(uuid,text,bigint,bigint) from public,anon,authenticated;
revoke all on function public.ads_wallet_claim_refill(uuid) from public,anon,authenticated;
grant execute on function public.ads_wallet_apply_payment(uuid,text,bigint,bigint), public.ads_wallet_claim_refill(uuid) to service_role;
create table public.ads_creative_uploads (
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 request_key text not null,
 input_hash text not null,
 file_id text,
 created_at timestamptz not null default now(),
 primary key (tenant_id,request_key)
);
alter table public.ads_creative_uploads enable row level security;
revoke all on public.ads_creative_uploads from public,anon,authenticated;
grant all on public.ads_creative_uploads to service_role;
commit;
