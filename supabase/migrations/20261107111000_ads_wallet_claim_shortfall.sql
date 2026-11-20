begin;

create or replace function public.ads_wallet_claim_shortfall(p_tenant_id uuid, p_order_id uuid, p_amount_cents integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  w ads_wallets%rowtype;
  o ads_wallet_orders%rowtype;
  today date := (now() at time zone 'UTC')::date;
  committed bigint;
begin
  if p_tenant_id is null or p_order_id is null or p_amount_cents is null or p_amount_cents < 100 or p_amount_cents > 100000 then
    raise exception 'ads_wallet_claim_shortfall: tenant, order and an amount of $1 to $1,000 are required';
  end if;
  select * into w from ads_wallets where tenant_id = p_tenant_id for update;
  if not found then return jsonb_build_object('status', 'no_wallet'); end if;
  select * into o from ads_wallet_orders where id = p_order_id for update;
  if found then
    if o.tenant_id <> p_tenant_id or o.kind <> 'refill' or o.amount_cents <> p_amount_cents then
      return jsonb_build_object('status', 'conflict');
    end if;
    return jsonb_build_object('status', 'claimed', 'order_id', o.id, 'order_status', o.status, 'replayed', true,
                              'payment_intent_id', o.payment_intent_id);
  end if;
  if not w.auto_refill_enabled or w.payment_method_id is null or w.stripe_customer_id is null then
    return jsonb_build_object('status', 'no_consented_card');
  end if;
  select coalesce(sum(amount_cents), 0) into committed from ads_wallet_orders
   where tenant_id = p_tenant_id and kind = 'refill'
     and (refill_day = today or (created_at at time zone 'UTC')::date = today);
  if committed + p_amount_cents > 100000 then
    return jsonb_build_object('status', 'daily_cap');
  end if;
  insert into ads_wallet_orders (id, tenant_id, kind, amount_cents, refill_day)
  values (p_order_id, p_tenant_id, 'refill', p_amount_cents, today);
  return jsonb_build_object('status', 'claimed', 'order_id', p_order_id, 'order_status', 'pending');
end $$;

revoke all on function public.ads_wallet_claim_shortfall(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.ads_wallet_claim_shortfall(uuid, uuid, integer) to service_role;
commit;
