
begin;

alter table creator_orders
  add column if not exists chargeback_status text
    check (chargeback_status is null or chargeback_status in ('open', 'won', 'lost')),
  add column if not exists stripe_dispute_id text
    check (stripe_dispute_id is null or length(stripe_dispute_id) <= 255);

create unique index if not exists creator_orders_stripe_dispute_id_key
  on creator_orders (stripe_dispute_id) where stripe_dispute_id is not null;

create or replace function creator_claim_order_transfer(p_order_id uuid)
returns creator_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row creator_orders;
begin
  update creator_orders o
     set payout_status = 'transferring', updated_at = now()
   where o.id = p_order_id
     and o.status = 'completed'
     and o.payout_status = 'ready'
     and o.payout_ready_at <= now()
     and not exists (select 1 from creator_disputes d where d.order_id = o.id and d.status = 'open')
     and coalesce(o.chargeback_status, '') not in ('open', 'lost')
  returning o.* into v_row;
  return v_row;
end $$;

revoke execute on function creator_claim_order_transfer(uuid) from public, anon, authenticated;
grant execute on function creator_claim_order_transfer(uuid) to service_role;

create unique index if not exists creator_orders_application_id_live_key
  on creator_orders (application_id)
  where application_id is not null and status <> 'cancelled';

drop index if exists creator_orders_application_id_key;

do $$
begin
  if exists (
    select 1
      from creator_orders
     where source = 'booking' and status = 'checkout_pending'
     group by tenant_id, human_member_id, package_id, booked_by_user_id
    having count(*) > 1
  ) then
    raise exception 'creator_orders_booking_pending_key: duplicate pending bookings exist; let them expire (25h) and redeploy';
  end if;
end $$;

create unique index if not exists creator_orders_booking_pending_key
  on creator_orders (tenant_id, human_member_id, package_id, booked_by_user_id)
  where source = 'booking' and status = 'checkout_pending';

commit;
