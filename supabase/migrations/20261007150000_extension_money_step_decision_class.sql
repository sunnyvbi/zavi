
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity) values
  ('extension.money_step', 'A step in the founder''s own browser tab that spends money (publish an ad, raise a budget, pay, checkout, subscribe). Confirmed only by the person running the task, on the panel card. Body: sealed host, label, op, value, frame, screenshot id, run owner, held op id. No dispatch: the waiting run executes it.', 'approval', null, true, false, 'high')
on conflict (slug) do update
  set description         = excluded.description,
      default_autonomy    = excluded.default_autonomy,
      dispatch_handler    = excluded.dispatch_handler,
      never_auto          = excluded.never_auto,
      click_allowlistable = excluded.click_allowlistable,
      severity            = excluded.severity;
