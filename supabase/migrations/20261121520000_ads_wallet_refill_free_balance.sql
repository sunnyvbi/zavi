begin;
create or replace function public.ads_wallet_claim_refill(p_tenant_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare w ads_wallets%rowtype; o ads_wallet_orders%rowtype; rid uuid;
 today date := (now() at time zone 'UTC')::date; committed bigint; reserved bigint;
begin
 select * into w from ads_wallets where tenant_id=p_tenant_id for update;
 if not found or not w.auto_refill_enabled or w.payment_method_id is null then return null; end if;
 if w.pending_refill_id is not null then
  select * into o from ads_wallet_orders where id=w.pending_refill_id and tenant_id=p_tenant_id and kind='refill' for update;
  if not found or o.status<>'pending' then return null; end if;
 else
  select coalesce(sum(reserved_cents),0) into reserved from ads_campaign_reservations where tenant_id=p_tenant_id;
  if w.balance_cents-reserved>=w.threshold_cents then return null; end if;
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
revoke all on function public.ads_wallet_claim_refill(uuid) from public,anon,authenticated;
grant execute on function public.ads_wallet_claim_refill(uuid) to service_role;
commit;
