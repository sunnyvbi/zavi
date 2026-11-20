
insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values
  (
    'customer-support-inbox.send-reply',
    'customer-support-inbox drafts a reply to an incoming support email. Body: { thread_id, to, subject, body_text, body_html }. Stub handler until Phase D2 wires gmail.send.',
    'approval',
    'gmail.send'
  ),
  (
    'supply-onboarding.action',
    'supply-onboarding posts a Slack DM to nudge a host through onboarding. Body: { channel_id, user_id, message }. Real handler.',
    'approval',
    'slack.post_message'
  ),
  (
    'dispute-response.submit-evidence',
    'dispute-response drafts compelling evidence for a Stripe chargeback. Body: { dispute_id, evidence_fields }. Stub handler until Phase D3 wires stripe.refund / dispute-evidence submission.',
    'approval',
    'stripe.refund'
  ),
  (
    'listing-quality.action',
    'listing-quality flags a marketplace listing for moderation. Body: { listing_id, reason, severity }. Notification-only via Slack until first tenant asks for autonomous moderation action.',
    'approval',
    'slack.post_message'
  ),
  (
    'payouts-recon.notify',
    'payouts-recon notifies operator of a payout discrepancy that needs manual review. Body: { tenant_id, anomaly_type, amount_delta, evidence }. Slack-only.',
    'approval',
    'slack.post_message'
  ),
  (
    'trust-safety.action',
    'trust-safety flags a user/transaction for review. Body: { subject_kind, subject_id, signal, severity }. Notification-only — autonomous suspend handler deferred until first customer ask.',
    'approval',
    'slack.post_message'
  )
on conflict (slug) do nothing;
