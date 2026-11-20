
insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values
  (
    'content-design.propose-change',
    'content-design proposes a content-change recommendation (clearer copy, a better label, structure, in-product microcopy, or a new/updated page) for the tenant''s connected GitHub repo, falling back to a provisioned site repo. Body shape: PrProposal envelope (creates/modifies a markdown/MDX or component file). Opens an approval-gated PR via the github.open_pr pipeline; never auto-publishes (never_auto=true).',
    'approval',
    'github.open_pr'
  )
on conflict (slug) do nothing;

update decision_classes
set never_auto = true
where slug = 'content-design.propose-change';
