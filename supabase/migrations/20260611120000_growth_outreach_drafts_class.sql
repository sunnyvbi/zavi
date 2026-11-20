insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values
  (
    'growth-lead.outreach-drafts',
    'Founder-facing outreach/draft bundle the founder copies and sends themselves (e.g. tutor-recruit WhatsApp/LinkedIn drafts + prospect list). Proposal-only — approve = acknowledge/done, nothing auto-executes. Body: { rendered_markdown, surface_kind:"founder_task", summary }.',
    'approval',
    null
  )
on conflict (slug) do nothing;
