
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity) values
  ('composio.write',        'Run a write action in a connected app (Composio). Body: frozen composio_write proposal (tool, arguments, labels, fingerprint).', 'approval', 'composio.execute_tool', false, false, 'medium'),
  ('composio.deletes_data', 'Run a write that deletes or archives data in a connected app (Composio).',                                                       'approval', 'composio.execute_tool', false, false, 'high'),
  ('composio.moves_money',  'Run a write in a connected payments or finance app (Composio). Moves money.',                                                   'approval', 'composio.execute_tool', false, false, 'high')
on conflict (slug) do nothing;
