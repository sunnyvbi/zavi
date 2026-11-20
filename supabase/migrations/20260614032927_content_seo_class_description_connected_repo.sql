
update decision_classes
set description = 'content-seo proposes a content-change recommendation (new SEO blog post) for the tenant''s connected GitHub repo, falling back to a provisioned site repo. Body shape: PrProposal envelope (creates a post file). Opens an approval-gated PR via the github.open_pr pipeline; never auto-publishes (never_auto=true).'
where slug = 'content-seo.publish-content';
