begin;

alter table public.creator_offers
  add column if not exists agent_run_id uuid;

create unique index if not exists creator_offers_agent_run_member_key
  on public.creator_offers (agent_run_id, human_member_id)
  where agent_run_id is not null;

do $$
begin
  if exists (
    select 1
      from public.creator_orders
     where source = 'booking' and status = 'checkout_pending' and booked_by_user_id is null
     group by tenant_id, human_member_id, package_id
    having count(*) > 1
  ) then
    raise exception 'creator_orders_agent_booking_pending_key: duplicate pending agent bookings exist; close them, then deploy again';
  end if;
end $$;

create unique index if not exists creator_orders_agent_booking_pending_key
  on public.creator_orders (tenant_id, human_member_id, package_id)
  where source = 'booking' and status = 'checkout_pending' and booked_by_user_id is null;

commit;
