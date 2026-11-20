
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'tenant_subscriptions' and column_name = 'source'
  ) then
    raise exception 'tenant_subscriptions.source is missing: apply 20260930150000 first';
  end if;
end $$;

drop function if exists apply_subscription_state(uuid, text, text, text, text, timestamptz, boolean, bigint);

create function apply_subscription_state(
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
    updated_at = now()
  where tenant_subscriptions.grandfathered = false
    and excluded.stripe_event_created > tenant_subscriptions.stripe_event_created
    and not (
      coalesce(tenant_subscriptions.source, 'stripe') in ('app_store', 'play_store', 'test_store')
      and tenant_subscriptions.status in ('active', 'trialing', 'past_due')
    );
  if found then return 'applied'; end if;

  select source, status into v_source, v_status
    from tenant_subscriptions where tenant_id = p_tenant_id;
  if coalesce(v_source, 'stripe') in ('app_store', 'play_store', 'test_store')
     and v_status in ('active', 'trialing', 'past_due') then
    return 'store_active';
  end if;
  return 'skipped';
end $$;

revoke all on function apply_subscription_state(uuid, text, text, text, text, timestamptz, boolean, bigint) from public, anon, authenticated;
grant execute on function apply_subscription_state(uuid, text, text, text, text, timestamptz, boolean, bigint) to service_role;
