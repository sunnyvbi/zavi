
insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values
  (
    'stripe.create_connected_account',
    'Provision a Stripe Connect payout account for the tenant. Body: { company_name }.',
    'approval',
    'stripe.create_connected_account'
  )
on conflict (slug) do nothing;
