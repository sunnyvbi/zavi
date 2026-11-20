
insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values
  ('browser.action', 'Execute an approved free-form browser write (click / form-fill) on a hostile/non-OAuth origin. Body: { op, selector?, value?, url? }. Reads/navs run inline and never emit this class.', 'approval', 'browser.action')
on conflict (slug) do nothing;
