
alter table tenant_subscriptions
  add column if not exists monthly_credits_event bigint not null default 0;

update tenant_subscriptions
   set monthly_credits_event = stripe_event_created
 where stripe_event_created > monthly_credits_event;

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
     and p_event_created > monthly_credits_event;
  if found then
    v_applied := true;
    perform _credit_balance_touch(p_tenant_id);
  end if;
  return v_applied;
end $$;

revoke all on function set_tenant_monthly_credits(uuid, int, bigint) from public, anon, authenticated;
grant execute on function set_tenant_monthly_credits(uuid, int, bigint) to service_role;

do $$
begin
  raise notice '20260630070300: set_tenant_monthly_credits(uuid,int,bigint) event-time-guarded overload + monthly_credits_event watermark';
end $$;
