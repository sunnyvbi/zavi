begin;

with closed as (
  update channel_actions
     set status = 'stale',
         status_at = now(),
         note = coalesce(note, 'Blog retired: SEO now writes one page a month.')
   where channel_slug = 'blog'
     and status in ('pending', 'snoozed')
     and exec_status is distinct from 'queued'
     and exec_status is distinct from 'dispatching'
  returning id, tenant_id
)
insert into channel_action_events (tenant_id, action_id, event, actor_kind, note, event_key)
select tenant_id, id, 'stale_flagged', 'system',
       'Blog retired: SEO now writes one page a month.',
       'blog_retired_20261016:' || id
from closed
on conflict (action_id, event_key) do nothing;

commit;
