
insert into decision_classes (slug, description, default_autonomy, dispatch_handler) values
  (
    'research.create-watch',
    'Create or replace the research agent''s scheduled monitor watch — re-run a watch ask on a cadence and report only what changed (approval-gated)',
    'approval',
    'praxis.create_research_watch'
  )
on conflict (slug) do nothing;
