
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto) values
  ('stripe.create_payment', 'Charge a customer via Stripe (money in)', 'approval', null, true),
  ('stripe.remit_to_tenant', 'Transfer funds out to a connected account (money out)', 'approval', null, true)
on conflict (slug) do update set
  description     = excluded.description,
  default_autonomy = 'approval',
  never_auto      = true;
