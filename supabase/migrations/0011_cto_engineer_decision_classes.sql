
insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values
  (
    'cto-engineer.ship-pr',
    'cto-engineer proposes a code change as a pull request. Body shape: PrProposal envelope.',
    'approval',
    'github.open_pr'
  ),
  (
    'pr-reviewer.post-review',
    'pr-reviewer posts a review comment on an open PR.',
    'approval',
    'github.post_review'
  ),
  (
    'pr-reviewer.merge-pr',
    'pr-reviewer squash-merges a PR. Forbidden by default — operator must raise to approval. Dispatch handler additionally requires CI green + ≥1 approval.',
    'forbidden',
    'github.merge_pr'
  )
on conflict (slug) do nothing;
