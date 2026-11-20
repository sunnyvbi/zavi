
insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values
  (
    'dispute-response.submit-evidence',
    'dispute-response submits a typed evidence packet to a Stripe dispute AFTER operator approval. Body: { rendered_markdown, evidence_packet: { dispute_id, evidence_fields, recommendation, win_band, ... } }. Handler stripe.submit_dispute_evidence maps the PII-guarded packet to the Stripe evidence object and saves it as a DRAFT (submit:false). A final submit (submit:true) requires a second explicit approval. Money path — autonomy=approval, never auto.',
    'approval',
    'stripe.submit_dispute_evidence'
  )
on conflict (slug) do update
  set description = excluded.description,
      default_autonomy = excluded.default_autonomy,
      dispatch_handler = excluded.dispatch_handler;
