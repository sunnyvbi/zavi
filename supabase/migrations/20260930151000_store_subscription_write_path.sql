
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
