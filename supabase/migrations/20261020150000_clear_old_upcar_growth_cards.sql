begin;

with closed as (
  update channel_actions
     set status = 'stale',
         status_at = now(),
         note = 'Cleared with the old Autopilot backlog (2026-10-07 cleanup, approved by Ravi)'
   where tenant_id = '73db45ff-457e-4541-bc8f-bdb625390204'
     and status in ('pending', 'snoozed')
     and proposed_at < '2026-10-07T00:00:00Z'
     and exec_status is distinct from 'queued'
     and exec_status is distinct from 'dispatching'
  returning id, tenant_id
)
insert into channel_action_events (tenant_id, action_id, event, actor_kind, note, event_key)
select tenant_id, id, 'stale_flagged', 'system',
       'Cleared with the old Autopilot backlog (2026-10-07 cleanup, approved by Ravi)',
       'backlog_cleanup_20261007:' || id
from closed
on conflict (action_id, event_key) do nothing;

commit;
