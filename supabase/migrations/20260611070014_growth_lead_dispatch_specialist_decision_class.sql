
insert into decision_classes (slug, description, default_autonomy, dispatch_handler) values
  (
    'growth-lead.dispatch-specialist',
    'Dispatch a specialist agent to act on an approved growth bet (approval-gated). Routed to praxis.dispatch_specialist; the founder approves once in /approvals to enqueue the specialist run.',
    'approval',
    'praxis.dispatch_specialist'
  )
on conflict (slug) do nothing;
