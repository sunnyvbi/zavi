
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto)
values (
  'fundraising.outbound.send',
  'Fundraising angel-round outbound send — always requires explicit approval. Body: { investor_id, recipient, channel, subject, body_text, sender, strategy_run_id? }. Routes through comms safety net (suppression + unsubscribe + 24h cap) before any wire send. Batch-authorizable by run_id via the Run-angel-round click; never auto-fires.',
  'approval',
  'fundraising.outbound.send',
  true
)
on conflict (slug) do nothing;
