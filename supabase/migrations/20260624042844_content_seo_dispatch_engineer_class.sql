insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values (
  'content-seo.dispatch-engineer',
  'content-seo routes a code-file content/SEO edit to the engineer agent. Body: target_agent_slug=engineer, intent, repo_hint, file_hints, context_summary, source_agent. On approval, enqueues an engineer run that opens its own gated PR.',
  'approval',
  'praxis.dispatch_specialist'
)
on conflict (slug) do update
  set description = excluded.description,
      default_autonomy = excluded.default_autonomy,
      dispatch_handler = excluded.dispatch_handler;

update decision_classes set never_auto = true where slug = 'content-seo.dispatch-engineer';
