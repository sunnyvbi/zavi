
alter table public.creator_orders
  add column if not exists product_needed boolean not null default false,
  add column if not exists product_received_at timestamptz;

alter table public.creator_briefs
  add column if not exists product_needed boolean not null default false;

alter table public.creator_offers
  add column if not exists product_needed boolean not null default false;

comment on column public.creator_orders.product_needed is
  'The business ships a product before work starts. due_at stays null until product_received.';
comment on column public.creator_orders.product_received_at is
  'When the creator marked the product as received. The delivery clock starts here.';
comment on column public.creator_briefs.product_needed is
  'Hires off this brief need a product shipped first. Copied onto the order at hire.';
comment on column public.creator_offers.product_needed is
  'The order made from this offer needs a product shipped first.';
