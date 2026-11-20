
alter table tenant_subscriptions drop constraint if exists tenant_subscriptions_source_check;
alter table tenant_subscriptions
  add constraint tenant_subscriptions_source_check
    check (source in ('stripe', 'app_store', 'play_store', 'test_store', 'shopify')),
  add column if not exists shopify_subscription_id text,
  add column if not exists shopify_shop text;

create unique index if not exists tenant_subscriptions_shopify_subscription_id_key
  on tenant_subscriptions (shopify_subscription_id)
  where shopify_subscription_id is not null;

create table if not exists shopify_billing_events (
  event_id text primary key,
  topic text,
  received_at timestamptz not null default now()
);

alter table shopify_billing_events enable row level security;
revoke all on table shopify_billing_events from public, anon, authenticated;
grant all on table shopify_billing_events to service_role;

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

  return 'applied';
end $$;

revoke all on function apply_shopify_subscription_state(uuid, text, text, text, text, timestamptz, boolean, bigint)
  from public, anon, authenticated;
grant execute on function apply_shopify_subscription_state(uuid, text, text, text, text, timestamptz, boolean, bigint)
  to service_role;

create or replace function apply_subscription_state(
  p_tenant_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_plan text,
  p_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_event_created bigint
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_source text;
  v_status text;
begin
  insert into tenant_subscriptions (
    tenant_id, stripe_customer_id, stripe_subscription_id, plan, status,
    current_period_end, cancel_at_period_end, stripe_event_created, source, updated_at
  ) values (
    p_tenant_id, p_stripe_customer_id, p_stripe_subscription_id, p_plan, p_status,
    p_current_period_end, coalesce(p_cancel_at_period_end, false), p_event_created, 'stripe', now()
  )
  on conflict (tenant_id) do update set
    stripe_customer_id = coalesce(excluded.stripe_customer_id, tenant_subscriptions.stripe_customer_id),
    stripe_subscription_id = excluded.stripe_subscription_id,
    plan = excluded.plan,
    status = excluded.status,
    current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end,
    stripe_event_created = excluded.stripe_event_created,
    source = 'stripe',
    store_app_user_id = null,
    shopify_shop = null,
    shopify_subscription_id = null,
    updated_at = now()
  where tenant_subscriptions.grandfathered = false
    and excluded.stripe_event_created > tenant_subscriptions.stripe_event_created
    and not (
      coalesce(tenant_subscriptions.source, 'stripe') in ('app_store', 'play_store', 'test_store', 'shopify')
      and tenant_subscriptions.status in ('active', 'trialing', 'past_due')
    );
  if found then return 'applied'; end if;

  select source, status into v_source, v_status
    from tenant_subscriptions where tenant_id = p_tenant_id;
  if v_source = 'shopify' and v_status in ('active', 'trialing', 'past_due') then
    return 'shopify_active';
  end if;
  if coalesce(v_source, 'stripe') in ('app_store', 'play_store', 'test_store')
     and v_status in ('active', 'trialing', 'past_due') then
    return 'store_active';
  end if;
  return 'skipped';
end $$;

revoke all on function apply_subscription_state(uuid, text, text, text, text, timestamptz, boolean, bigint) from public, anon, authenticated;
grant execute on function apply_subscription_state(uuid, text, text, text, text, timestamptz, boolean, bigint) to service_role;

create or replace function apply_store_subscription_state(
  p_tenant_id uuid,
  p_source text,
  p_store_app_user_id text,
  p_store_product_id text,
  p_tier text,
  p_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_event_ms bigint,
  p_refund_reversed boolean default false,
  p_refund boolean default false
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row tenant_subscriptions%rowtype;
  v_unblock boolean := false;
  v_tier text := case when p_refund then null else p_tier end;
  v_status text := case when p_refund then 'canceled' else p_status end;
  v_cancel boolean := case when p_refund then false else p_cancel_at_period_end end;
begin
  select * into v_row from tenant_subscriptions where tenant_id = p_tenant_id for update;

  if found then
    if v_row.grandfathered then return 'grandfathered'; end if;
    if p_event_ms < v_row.store_event_created then return 'stale'; end if;
    if p_event_ms = v_row.store_event_created
       and not (p_refund_reversed and v_row.credits_revoked_at is not null) then
      return 'replay';
    end if;
    if coalesce(v_row.source, 'stripe') = 'stripe'
       and v_row.stripe_subscription_id is not null
       and v_row.status in ('active', 'trialing', 'past_due') then
      return 'stripe_active';
    end if;
    if v_row.source = 'shopify' and v_row.status in ('active', 'trialing', 'past_due') then
      return 'shopify_active';
    end if;
    if v_row.credits_revoked_at is not null then
      if p_refund_reversed and v_row.store_app_user_id = p_store_app_user_id then
        v_unblock := true;
      elsif p_tier is not null or v_row.store_app_user_id is distinct from p_store_app_user_id then
        return 'refund_blocked';
      end if;
    end if;
  end if;

  if exists (
    select 1 from tenant_subscriptions
     where store_app_user_id = p_store_app_user_id
       and tenant_id <> p_tenant_id
       and status in ('active', 'trialing', 'past_due')
  ) then
    return 'store_account_in_use';
  end if;

  if p_refund and v_row.tenant_id is null then return 'stale'; end if;

  update tenant_subscriptions
     set store_app_user_id = null, updated_at = now()
   where store_app_user_id = p_store_app_user_id
     and tenant_id <> p_tenant_id;

  insert into tenant_subscriptions (
    tenant_id, plan, status, tier, source, store_app_user_id, store_product_id,
    current_period_end, cancel_at_period_end, store_event_created, tier_event_created, updated_at
  ) values (
    p_tenant_id,
    case when p_tier is null then 'free' else 'team' end,
    v_status, v_tier, p_source, p_store_app_user_id, p_store_product_id,
    p_current_period_end, v_cancel, p_event_ms, p_event_ms / 1000, now()
  )
  on conflict (tenant_id) do update set
    plan                 = excluded.plan,
    status               = excluded.status,
    tier                 = excluded.tier,
    source               = excluded.source,
    store_app_user_id    = excluded.store_app_user_id,
    store_product_id     = excluded.store_product_id,
    stripe_subscription_id = null,
    shopify_shop         = null,
    shopify_subscription_id = null,
    current_period_end   = coalesce(excluded.current_period_end, tenant_subscriptions.current_period_end),
    cancel_at_period_end = excluded.cancel_at_period_end,
    store_event_created  = excluded.store_event_created,
    tier_event_created   = greatest(tenant_subscriptions.tier_event_created, excluded.tier_event_created),
    comp_expires_at      = null,
    monthly_credits      = case when p_refund then 0 else tenant_subscriptions.monthly_credits end,
    monthly_usd          = case when p_refund then null else tenant_subscriptions.monthly_usd end,
    credits_revoked_at   = case when p_refund then now()
                                when v_unblock then null
                                else tenant_subscriptions.credits_revoked_at end,
    monthly_credits_event = case when p_refund
                                 then greatest(tenant_subscriptions.monthly_credits_event, p_event_ms / 1000)
                                 when v_unblock
                                 then least(tenant_subscriptions.monthly_credits_event, p_event_ms / 1000 - 1)
                                 else tenant_subscriptions.monthly_credits_event end,
    updated_at           = now();

  if p_refund then perform _credit_balance_touch(p_tenant_id); end if;

  return 'applied';
end $$;

revoke all on function apply_store_subscription_state(uuid, text, text, text, text, text, timestamptz, boolean, bigint, boolean, boolean)
  from public, anon, authenticated;
grant execute on function apply_store_subscription_state(uuid, text, text, text, text, text, timestamptz, boolean, bigint, boolean, boolean)
  to service_role;
