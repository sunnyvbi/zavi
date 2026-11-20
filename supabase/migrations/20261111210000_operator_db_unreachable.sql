
alter table tenant_db_config add column if not exists unreachable_since timestamptz;
alter table tenant_db_config add column if not exists unreachable_decision_id uuid;

insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity) values
  ('operator_db.unreachable', 'Zavi cannot connect to the workspace''s database. Raised by the data gateway on the first connection failure of an outage, superseded on the first successful connect. Body: {kind:"operator_db_unreachable", outage_started_at, rationale, rendered_markdown}.', 'approval', null, true, false, 'high')
on conflict (slug) do update
  set description         = excluded.description,
      default_autonomy    = excluded.default_autonomy,
      dispatch_handler    = excluded.dispatch_handler,
      never_auto          = excluded.never_auto,
      click_allowlistable = excluded.click_allowlistable,
      severity            = excluded.severity;

update system_config
set blob = jsonb_set(coalesce(blob, '{}'::jsonb), '{egress_ips}', '["54.241.199.146", "184.169.192.250"]'::jsonb, true),
    updated_at = now()
where id = 1 and not (coalesce(blob, '{}'::jsonb) ? 'egress_ips');
