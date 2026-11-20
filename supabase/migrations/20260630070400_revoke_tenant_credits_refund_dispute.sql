
create or replace function revoke_tenant_credits(
  p_tenant_id uuid, p_event_created bigint
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_applied boolean := false;
begin
  update tenant_subscriptions
     set monthly_credits       = null,
         plan                  = 'free',
         monthly_credits_event = p_event_created,
         updated_at            = now()
   where tenant_id = p_tenant_id
     and p_event_created >= monthly_credits_event;
  if found then
    v_applied := true;
    perform _credit_balance_touch(p_tenant_id);
  end if;
  return v_applied;
end $$;

revoke all on function revoke_tenant_credits(uuid, bigint) from public, anon, authenticated;
grant execute on function revoke_tenant_credits(uuid, bigint) to service_role;

do $$
begin
  raise notice '20260630070400: revoke_tenant_credits(uuid,bigint) — refund/dispute revoke under shared monotonic watermark';
end $$;
