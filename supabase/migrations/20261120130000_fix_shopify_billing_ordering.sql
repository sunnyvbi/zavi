
create or replace function apply_shopify_subscription_state(
  p_tenant_id uuid,
  p_shop text,
  p_shopify_subscription_id text,
  p_tier text,
  p_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_event_ms bigint
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row tenant_subscriptions%rowtype;
begin
  select * into v_row from tenant_subscriptions where tenant_id = p_tenant_id for update;

  if found then
    if v_row.grandfathered then return 'grandfathered'; end if;
    if v_row.source = 'shopify'
       and v_row.status in ('active', 'trialing', 'past_due')
       and v_row.shopify_shop is distinct from p_shop then
      return 'other_shop_active';
    end if;
    if p_tier is null
       and p_shopify_subscription_id is not null
       and v_row.source = 'shopify'
       and v_row.status in ('active', 'trialing', 'past_due')
       and v_row.shopify_subscription_id is distinct from p_shopify_subscription_id then
      return 'stale';
    end if;
    if p_event_ms < v_row.store_event_created then return 'stale'; end if;
    if p_event_ms = v_row.store_event_created then return 'replay'; end if;
    if coalesce(v_row.source, 'stripe') = 'stripe'
       and v_row.stripe_subscription_id is not null
       and v_row.status in ('active', 'trialing', 'past_due') then
      return 'stripe_active';
    end if;
    if v_row.source in ('app_store', 'play_store', 'test_store')
       and v_row.status in ('active', 'trialing', 'past_due') then
      return 'store_active';
    end if;
    if v_row.credits_revoked_at is not null and p_tier is not null then
      return 'refund_blocked';
    end if;
  end if;

  if exists (
    select 1 from tenant_subscriptions
     where shopify_shop = p_shop
       and tenant_id <> p_tenant_id
       and source = 'shopify'
       and status in ('active', 'trialing', 'past_due')
  ) then
    return 'shop_in_use';
  end if;

  update tenant_subscriptions
     set shopify_shop = null, shopify_subscription_id = null, updated_at = now()
   where shopify_shop = p_shop
     and tenant_id <> p_tenant_id;

  insert into tenant_subscriptions (
    tenant_id, plan, status, tier, source, shopify_shop, shopify_subscription_id,
    current_period_end, cancel_at_period_end, store_event_created, tier_event_created, updated_at
  ) values (
    p_tenant_id,
    case when p_tier is null then 'free' else 'team' end,
    p_status, p_tier, 'shopify', p_shop, p_shopify_subscription_id,
    p_current_period_end, coalesce(p_cancel_at_period_end, false), p_event_ms, p_event_ms / 1000, now()
  )
  on conflict (tenant_id) do update set
    plan                    = excluded.plan,
    status                  = excluded.status,
    tier                    = excluded.tier,
    source                  = excluded.source,
    shopify_shop            = excluded.shopify_shop,
    shopify_subscription_id = excluded.shopify_subscription_id,
    stripe_subscription_id  = null,
    store_app_user_id       = null,
    store_product_id        = null,
    current_period_end      = coalesce(excluded.current_period_end, tenant_subscriptions.current_period_end),
    cancel_at_period_end    = excluded.cancel_at_period_end,
    store_event_created     = excluded.store_event_created,
    tier_event_created      = greatest(tenant_subscriptions.tier_event_created, excluded.tier_event_created),
    comp_expires_at         = null,
    updated_at              = now();

  perform set_tenant_monthly_credits(
    p_tenant_id, null::int, null::int, p_event_ms / 1000
  );

  return 'applied';
end $$;

revoke all on function apply_shopify_subscription_state(uuid, text, text, text, text, timestamptz, boolean, bigint)
  from public, anon, authenticated;
grant execute on function apply_shopify_subscription_state(uuid, text, text, text, text, timestamptz, boolean, bigint)
  to service_role;

create or replace function apply_verified_shopify_subscription_state(
  p_tenant_id uuid,
  p_shop text,
  p_shopify_subscription_id text,
  p_tier text,
  p_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_expected_event_ms bigint,
  p_event_ms bigint
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row tenant_subscriptions%rowtype;
begin
  select * into v_row from tenant_subscriptions where tenant_id = p_tenant_id for update;
  if not found
     or v_row.source is distinct from 'shopify'
     or v_row.status is distinct from 'canceled'
     or v_row.shopify_shop is distinct from p_shop
     or v_row.store_event_created is distinct from p_expected_event_ms then
    return 'stale';
  end if;

  return apply_shopify_subscription_state(
    p_tenant_id,
    p_shop,
    p_shopify_subscription_id,
    p_tier,
    p_status,
    p_current_period_end,
    p_cancel_at_period_end,
    p_event_ms
  );
end $$;

revoke all on function apply_verified_shopify_subscription_state(uuid, text, text, text, text, timestamptz, boolean, bigint, bigint)
  from public, anon, authenticated;
grant execute on function apply_verified_shopify_subscription_state(uuid, text, text, text, text, timestamptz, boolean, bigint, bigint)
  to service_role;
