
set local lock_timeout = '5s';

create or replace function public.decisions_ring_attention()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_new boolean := coalesce(new.status = 'proposed'
    and new.autonomy_at_emit is not distinct from 'approval'
    and new.decision_class <> 'cgo.dispatch-specialist', false);
  v_old boolean := false;
begin
  if tg_op = 'UPDATE' then
    v_old := coalesce(old.status = 'proposed'
      and old.autonomy_at_emit is not distinct from 'approval'
      and old.decision_class <> 'cgo.dispatch-specialist', false);
  end if;
  if not (v_new or v_old) then
    return null;
  end if;
  if tg_op = 'UPDATE'
     and v_new = v_old
     and new.archived_at is not distinct from old.archived_at
     and new.snoozed_until is not distinct from old.snoozed_until
     and new.home is not distinct from old.home then
    return null;
  end if;
  insert into public.thread_event (tenant_id, agent_slug, kind, body)
  values (
    new.tenant_id,
    '_attention',
    'attention',
    jsonb_build_object('decision_id', new.id, 'home', new.home)
  );
  return null;
end;
$$;

revoke all on function public.decisions_ring_attention() from public, anon, authenticated;

drop trigger if exists decisions_ring_attention on public.decisions;
create trigger decisions_ring_attention
  after insert or update of status, autonomy_at_emit, decision_class, archived_at, snoozed_until, home
  on public.decisions
  for each row
  execute function public.decisions_ring_attention();

create or replace function public.latest_assistant_messages(p_thread_ids uuid[])
returns table (
  thread_id uuid,
  created_at timestamptz,
  body_head text,
  is_question boolean
)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select distinct on (m.thread_id)
    m.thread_id,
    m.created_at,
    left(m.body, 400) as body_head,
    coalesce(m.meta ->> 'envelope_schema' = 'clarifying_questions', false) as is_question
  from public.agent_thread_messages m
  where m.thread_id = any(p_thread_ids[1:200])
    and m.sender_role = 'assistant'
  order by m.thread_id, m.created_at desc, m.id desc;
$$;

revoke all on function public.latest_assistant_messages(uuid[]) from public, anon, authenticated;
grant execute on function public.latest_assistant_messages(uuid[]) to authenticated;

create index if not exists agent_thread_messages_thread_role_recent
  on public.agent_thread_messages (thread_id, sender_role, created_at desc, id desc);

alter table public.thread_event
  drop constraint if exists thread_event_kind_check;
alter table public.thread_event
  add constraint thread_event_kind_check
  check (kind in (
    'chat_user',
    'chat_assistant',
    'run_start',
    'reasoning',
    'plan',
    'plan_critic_verdict',
    'tool_call',
    'file_read',
    'file_edit',
    'file_create',
    'decision',
    'run_end',
    'attention'
  )) not valid;
