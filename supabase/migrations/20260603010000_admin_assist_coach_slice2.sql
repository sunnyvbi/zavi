
begin;

alter table admin_tasks drop constraint if exists admin_tasks_kind_check;
alter table admin_tasks
  add constraint admin_tasks_kind_check check (kind in ('enrichment','unblock','coach'));

alter table admin_tasks
  add column if not exists agent_slug   text,
  add column if not exists detector     text,
  add column if not exists started_at   timestamptz,
  add column if not exists completed_at timestamptz;

create index if not exists admin_tasks_coach_idx
  on admin_tasks (tenant_id, agent_slug, detector, created_at desc)
  where kind = 'coach';

create or replace function admin_task_create_with_cooldown(
  p_tenant_id      uuid,
  p_agent_slug     text,
  p_detector       text,
  p_cooldown_hours int default 24,
  p_priority       int default 0
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id     uuid;
  v_bucket bigint;
  v_key    text;
begin
  if p_tenant_id is null or p_agent_slug is null or p_detector is null then
    raise exception 'admin_task_create_with_cooldown: tenant_id, agent_slug, detector required'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('coach:'||p_tenant_id::text||':'||p_agent_slug||':'||p_detector, 0));

  if exists (
    select 1 from admin_tasks
    where tenant_id = p_tenant_id
      and kind = 'coach'
      and agent_slug = p_agent_slug
      and detector = p_detector
      and (state not in ('resolved','dismissed')
           or created_at > now() - make_interval(hours => p_cooldown_hours))
  ) then
    return null;
  end if;

  v_bucket := floor(extract(epoch from now()) / 3600);
  v_key := 'coach:'||p_tenant_id::text||':'||p_detector||':'||p_agent_slug||':'||v_bucket::text;

  insert into admin_tasks (kind, tenant_id, agent_slug, detector, idempotency_key, priority)
  values ('coach', p_tenant_id, p_agent_slug, p_detector, v_key, p_priority)
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  return v_id;
end $$;

revoke all on function admin_task_create_with_cooldown(uuid,text,text,int,int) from public, anon, authenticated;
grant execute on function admin_task_create_with_cooldown(uuid,text,text,int,int) to service_role;

commit;
