
create index if not exists agent_thread_messages_tenant_user_recent_idx
  on public.agent_thread_messages (tenant_id, created_at desc)
  where sender_role = 'user';

create index if not exists praxis_logs_tenant_workspace_opened_idx
  on public.praxis_logs (tenant_id, created_at desc)
  where code = 'workspace.opened';

insert into public.praxis_logs (created_at, level, source, code, tenant_id)
select max(created_at), 'info', 'migration/20261118090000_tenant_idle_indexes', 'workspace.opened', tenant_id
from public.praxis_logs
where code = 'approvals.list_served'
  and tenant_id is not null
  and created_at >= now() - interval '7 days'
  and not exists (
    select 1 from public.praxis_logs done
    where done.source = 'migration/20261118090000_tenant_idle_indexes'
  )
group by tenant_id;

create index if not exists channel_action_events_tenant_founder_at_idx
  on public.channel_action_events (tenant_id, at desc)
  where actor_kind = 'founder';

create index if not exists decisions_tenant_approved_at_idx
  on public.decisions (tenant_id, approved_at desc)
  where approved_by is not null;

create index if not exists decisions_tenant_rejected_at_idx
  on public.decisions (tenant_id, rejected_at desc)
  where rejected_by is not null;

create index if not exists cgo_questions_tenant_answered_at_idx
  on public.cgo_questions (tenant_id, answered_at desc)
  where answered_at is not null;
