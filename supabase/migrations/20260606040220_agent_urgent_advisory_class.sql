insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values
  (
    'agent.urgent_advisory',
    'An agent surfaces an URGENT advisory recommendation that has NO executable action (a heads-up, not a side effect). Side-effect-free; dispatch_handler is NULL so Approve = a no-op "Got it" and Reject = a recorded terminal dismiss. Carries NO spend/executable body.',
    'approval',
    null
  )
on conflict (slug) do nothing;

update system_config
set blob = jsonb_set(coalesce(blob, '{}'::jsonb), '{urgent_flags_as_cards_enabled}', 'false'::jsonb, true),
    updated_at = now()
where id = 1;
