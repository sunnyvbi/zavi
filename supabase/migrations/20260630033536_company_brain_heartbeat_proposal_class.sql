
begin;

insert into decision_classes
  (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable)
values (
  'heartbeat.automation-proposal',
  'Company-brain heartbeat — proposes automating a manual/agent action the tenant repeated on a cadence. Founder approves -> handler inserts/enables a tenant_agent_schedules row (cadence + agent + objective from the proposal) so scheduled-runs runs it. Approval-gated; NEVER auto (creates a recurring action).',
  'approval',
  'heartbeat.automation_proposal_approve',
  true,
  false
)
on conflict (slug) do update set
  description         = excluded.description,
  default_autonomy    = excluded.default_autonomy,
  dispatch_handler    = excluded.dispatch_handler,
  never_auto          = excluded.never_auto,
  click_allowlistable = excluded.click_allowlistable;

commit;
