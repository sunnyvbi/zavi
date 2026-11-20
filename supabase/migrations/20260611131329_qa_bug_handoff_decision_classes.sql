
insert into decision_classes (slug, description, default_autonomy, dispatch_handler) values
  (
    'qa.bug-report',
    'qa files a typed bug artifact for a FAILED test (Mode B). Body: { test_case_id, test_title, classification(new|persistent), consecutive_red, steps, expected_outcome, actual_observed, artifact_ref, source_run_id, rendered_markdown }. Proposal-only (no dispatch handler) — the bug decision is the artifact; approving it acknowledges/files it with no side effect (file-not-fix default).',
    'approval',
    null
  ),
  (
    'qa.dispatch-specialist',
    'Dispatch the engineer agent to fix a QA-detected bug (approval-gated; github-connected tenants only). Routed to praxis.dispatch_specialist; the founder approves once in /approvals to enqueue the engineer run, which ships a PR. Pre-approval emit executes zero spend.',
    'approval',
    'praxis.dispatch_specialist'
  )
on conflict (slug) do nothing;
