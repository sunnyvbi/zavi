
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto)
values
  ('generated_video.generate.v1',
   'Creator-style (UGC) video staged by the generated_video channel. Body: {concept, format, hook, beats[], creator, caption, duration_seconds, aspect_ratio, generation_prompt, rationale}. Approval-gated and never auto: approving records the operator go-ahead against the frozen script. No dispatch handler yet — the render step spends the tenant''s own Higgsfield credits and is enabled separately.',
   'approval',
   null,
   true)
on conflict (slug) do update
  set description = excluded.description,
      never_auto = true;
