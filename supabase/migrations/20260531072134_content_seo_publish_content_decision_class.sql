
insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values
  (
    'content-seo.publish-content',
    'content-seo proposes publishing an SEO blog post to the tenant''s provisioned site repo. Body shape: PrProposal envelope (creates content/blog/<slug>.md). Opens an approval-gated PR via the engineer github.open_pr pipeline.',
    'approval',
    'github.open_pr'
  )
on conflict (slug) do nothing;
