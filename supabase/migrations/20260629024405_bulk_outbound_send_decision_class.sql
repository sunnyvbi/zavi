
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto)
values (
  'bulk_outbound.send',
  'Bulk first-party cohort email — always requires explicit approval; never auto-fires. Body: { selector, template:{subject,body_text,body_html?}, est_recipient_count, sample_recipients, basis }. The agent supplies a SELECTOR (who), never a recipient list; the server resolves actual addresses from the tenant''s OWN records filtered by the tenant''s outbound_basis (opt_in default / relationship). On approval the cohort is RE-RESOLVED server-side and each recipient routes through the comms safety net (suppression + unsubscribe + rolling-24h cap) before any wire send. Gated behind the per-tenant bulk_outbound_enabled flag (default off).',
  'approval',
  'bulk_outbound.send',
  true
)
on conflict (slug) do nothing;
