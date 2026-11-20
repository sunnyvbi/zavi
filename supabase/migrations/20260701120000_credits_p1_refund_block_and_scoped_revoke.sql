
alter table tenant_subscriptions
  add column if not exists credits_revoked_at timestamptz;

drop function if exists set_tenant_monthly_credits(uuid, int);

create or replace function set_tenant_monthly_credits(
  p_tenant_id uuid, p_monthly_credits int, p_event_created bigint
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_applied boolean := false;
begin
  update tenant_subscriptions
     set monthly_credits       = p_monthly_credits,
         monthly_credits_event = p_event_created,
         updated_at            = now()
   where tenant_id = p_tenant_id
     and p_event_created > monthly_credits_event
     and credits_revoked_at is null;
  if found then
    v_applied := true;
    perform _credit_balance_touch(p_tenant_id);
  end if;
  return v_applied;
end $$;

revoke all on function set_tenant_monthly_credits(uuid, int, bigint) from public, anon, authenticated;
grant execute on function set_tenant_monthly_credits(uuid, int, bigint) to service_role;

drop function if exists revoke_tenant_credits(uuid, bigint);
create or replace function revoke_tenant_credits(
  p_tenant_id uuid, p_event_created bigint, p_stripe_subscription_id text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_applied boolean := false;
begin
  update tenant_subscriptions
     set monthly_credits       = 0,
         credits_revoked_at     = now(),
         monthly_credits_event  = p_event_created,
         updated_at             = now()
   where tenant_id = p_tenant_id
     and grandfathered = false
     and p_stripe_subscription_id is not null
     and stripe_subscription_id = p_stripe_subscription_id
     and p_event_created >= monthly_credits_event;
  if found then
    v_applied := true;
    perform _credit_balance_touch(p_tenant_id);
  end if;
  return v_applied;
end $$;

revoke all on function revoke_tenant_credits(uuid, bigint, text) from public, anon, authenticated;
grant execute on function revoke_tenant_credits(uuid, bigint, text) to service_role;

create or replace function clear_credit_revocation(
  p_tenant_id uuid, p_monthly_credits int default null, p_event_created bigint default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_found boolean := false;
begin
  update tenant_subscriptions
     set credits_revoked_at = null,
         monthly_credits     = case when p_monthly_credits is not null then p_monthly_credits
                                    else monthly_credits end,
         monthly_credits_event = greatest(
                                   monthly_credits_event,
                                   coalesce(p_event_created, 0),
                                   floor(extract(epoch from now()))::bigint
                                 ),
         updated_at          = now()
   where tenant_id = p_tenant_id
     and credits_revoked_at is not null;
  if found then
    v_found := true;
    perform _credit_balance_touch(p_tenant_id);
  end if;
  return v_found;
end $$;

revoke all on function clear_credit_revocation(uuid, int, bigint) from public, anon, authenticated;
grant execute on function clear_credit_revocation(uuid, int, bigint) to service_role;

do $$
begin
  raise notice '20260701120000: durable credits_revoked_at block + subscription-scoped revoke_tenant_credits(uuid,bigint,text) + clear_credit_revocation';
end $$;
