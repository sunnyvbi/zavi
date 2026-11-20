
insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values
  (
    'outbound.send',
    'Approval route - outbound (cold / SDR first-touch) message proposed by outbound-sdr. Body: { channel, to, subject, body_text, body_html? }. On approval the send routes through the comms safety net (suppression + unsubscribe + rolling-24h cap) before any wire send; never auto-sends.',
    'approval',
    'outbound.send'
  )
on conflict (slug) do nothing;
