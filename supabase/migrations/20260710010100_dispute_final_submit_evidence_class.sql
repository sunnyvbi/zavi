
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto)
values
  (
    'dispute-response.final-submit-evidence',
    'SECOND-approval class that FINAL-submits an already-drafted Stripe dispute evidence packet (submit:true — files it for network review and closes the dispute for further evidence). Emitted + owner-approved by the finalize-evidence route after the owner approved the draft (dispute-response.submit-evidence). Body: { evidence_packet, submit_final: true, source_draft_decision_id }. Money path — approval-only, NEVER auto (never_auto=true).',
    'approval',
    'stripe.submit_dispute_evidence',
    true
  )
on conflict (slug) do update
  set description      = excluded.description,
      default_autonomy = excluded.default_autonomy,
      dispatch_handler = excluded.dispatch_handler,
      never_auto       = excluded.never_auto;
