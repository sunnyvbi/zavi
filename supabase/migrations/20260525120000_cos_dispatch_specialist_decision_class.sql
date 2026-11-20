
insert into decision_classes (slug, description, default_autonomy, dispatch_handler) values
  (
    'chief-of-staff.dispatch-specialist',
    'Dispatch a specialist agent to act on a Tier-1 digest item (approval-gated)',
    'approval',
    'praxis.dispatch_specialist'
  )
on conflict (slug) do nothing;
