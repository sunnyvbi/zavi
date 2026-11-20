
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.creator_orders'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%offer_expiry%'
  loop
    execute format('alter table public.creator_orders drop constraint %I', c);
  end loop;
end $$;

alter table public.creator_orders
  add constraint creator_orders_next_deadline_kind_check
  check (next_deadline_kind is null or next_deadline_kind in (
    'accept', 'review', 'due', 'no_show_grace', 'cancel_response', 'offer_expiry', 'checkout_expiry'));

update public.creator_orders o
   set next_deadline_kind = 'offer_expiry',
       next_deadline_at   = f.expires_at
  from public.creator_offers f
 where o.status = 'checkout_pending'
   and o.source = 'offer'
   and o.next_deadline_at is null
   and f.id = o.offer_id
   and f.tenant_id = o.tenant_id;

update public.creator_orders
   set next_deadline_kind = 'checkout_expiry',
       next_deadline_at   = created_at + interval '25 hours'
 where status = 'checkout_pending'
   and next_deadline_at is null;
