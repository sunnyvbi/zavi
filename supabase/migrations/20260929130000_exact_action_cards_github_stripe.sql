
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto)
values
  (
    'github.open_pr_direct',
    'An agent''s direct github open_pr / push_to_main call, shown as the exact change (repo, branches, title, description, files). Runs github.open_pr after approval. Approval-only, never auto.',
    'approval',
    'github.open_pr',
    true
  ),
  (
    'github.merge_pr_direct',
    'An agent''s direct github squash_merge call. Runs github.merge_pr after approval, which merges only with green CI and at least one approving review. Approval-only, never auto.',
    'approval',
    'github.merge_pr',
    true
  )
on conflict (slug) do update
  set description      = excluded.description,
      default_autonomy = excluded.default_autonomy,
      dispatch_handler = excluded.dispatch_handler,
      never_auto       = excluded.never_auto;

update decision_classes
   set dispatch_handler = 'stripe.create_payment', default_autonomy = 'approval', never_auto = true
 where slug = 'stripe.create_payment';

update decision_classes
   set dispatch_handler = 'stripe.remit_to_tenant', default_autonomy = 'approval', never_auto = true
 where slug = 'stripe.remit_to_tenant';
