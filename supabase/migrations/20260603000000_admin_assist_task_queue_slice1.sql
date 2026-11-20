
begin;

create table if not exists admin_tasks (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null check (kind in ('enrichment','unblock')),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  source_decision_id  uuid references decisions(id) on delete set null,
  source_run_id       uuid references agent_runs(id) on delete set null,
  block_reason        text check (block_reason in ('missing_info','needs_decision','low_confidence','capability_gap')),
  state               text not null default 'open'
                        check (state in ('open','claimed','in_progress','snoozed','resolved','dismissed')),
  assignee_staff_email text,
  snooze_until        timestamptz,
  priority            int not null default 0,
  resolution          jsonb,
  idempotency_key     text not null unique,
  created_at          timestamptz not null default now(),
  claimed_at          timestamptz,
  resolved_at         timestamptz
);

create index if not exists admin_tasks_open_idx
  on admin_tasks (state, priority desc, created_at)
  where state in ('open','claimed','in_progress','snoozed');
create index if not exists admin_tasks_tenant_idx
  on admin_tasks (tenant_id, created_at desc);

alter table admin_tasks enable row level security;

create table if not exists admin_action_log (
  id            uuid primary key default gen_random_uuid(),
  staff_email   text not null,
  tenant_id     uuid not null references tenants(id) on delete cascade,
  task_id       uuid references admin_tasks(id) on delete set null,
  action        text not null,
  target        text,
  before_state  jsonb,
  after_state   jsonb,
  on_behalf     boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists admin_action_log_tenant_idx
  on admin_action_log (tenant_id, created_at desc);
create index if not exists admin_action_log_task_idx
  on admin_action_log (task_id, created_at);

alter table admin_action_log enable row level security;

create or replace function admin_action_log_worm_guard()
returns trigger language plpgsql as $$
begin
  raise exception 'admin_action_log is append-only (WORM): % blocked', tg_op
    using errcode = '42501';
end $$;

drop trigger if exists admin_action_log_worm on admin_action_log;
create trigger admin_action_log_worm
  before update or delete on admin_action_log
  for each row execute function admin_action_log_worm_guard();

create or replace function admin_tasks_tenant_consistency()
returns trigger language plpgsql as $$
declare v_t uuid;
begin
  if new.source_run_id is not null then
    select tenant_id into v_t from agent_runs where id = new.source_run_id;
    if v_t is not null and v_t <> new.tenant_id then
      raise exception 'admin_tasks: source_run_id % belongs to tenant %, not %',
        new.source_run_id, v_t, new.tenant_id using errcode = '23514';
    end if;
  end if;
  if new.source_decision_id is not null then
    select tenant_id into v_t from decisions where id = new.source_decision_id;
    if v_t is not null and v_t <> new.tenant_id then
      raise exception 'admin_tasks: source_decision_id % belongs to tenant %, not %',
        new.source_decision_id, v_t, new.tenant_id using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists admin_tasks_tenant_consistency_t on admin_tasks;
create trigger admin_tasks_tenant_consistency_t
  before insert or update on admin_tasks
  for each row execute function admin_tasks_tenant_consistency();

create or replace function admin_action_log_tenant_consistency()
returns trigger language plpgsql as $$
declare v_t uuid;
begin
  if new.task_id is not null then
    select tenant_id into v_t from admin_tasks where id = new.task_id;
    if v_t is not null and v_t <> new.tenant_id then
      raise exception 'admin_action_log: task_id % belongs to tenant %, not %',
        new.task_id, v_t, new.tenant_id using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists admin_action_log_tenant_consistency_t on admin_action_log;
create trigger admin_action_log_tenant_consistency_t
  before insert on admin_action_log
  for each row execute function admin_action_log_tenant_consistency();

alter table memory_note
  add column if not exists last_edited_by_staff_at    timestamptz,
  add column if not exists last_edited_by_staff_email text;

create or replace function admin_task_create_once(
  p_kind               text,
  p_tenant_id          uuid,
  p_idempotency_key    text,
  p_block_reason       text default null,
  p_source_decision_id uuid default null,
  p_source_run_id      uuid default null,
  p_priority           int  default 0
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_tenant_id is null or p_kind is null or p_idempotency_key is null then
    raise exception 'admin_task_create_once: kind, tenant_id, idempotency_key required'
      using errcode = '22023';
  end if;
  insert into admin_tasks (kind, tenant_id, idempotency_key, block_reason,
                           source_decision_id, source_run_id, priority)
  values (p_kind, p_tenant_id, p_idempotency_key, p_block_reason,
          p_source_decision_id, p_source_run_id, p_priority)
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from admin_tasks where idempotency_key = p_idempotency_key;
  end if;
  return v_id;
end $$;

create or replace function admin_task_claim(
  p_task_id uuid,
  p_staff_email text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  update admin_tasks
     set state = 'claimed', assignee_staff_email = p_staff_email, claimed_at = now()
   where id = p_task_id and state = 'open'
  returning id into v_id;
  return v_id;
end $$;

create or replace function admin_task_snooze(
  p_task_id uuid,
  p_until timestamptz
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  update admin_tasks
     set state = 'snoozed', snooze_until = p_until
   where id = p_task_id and state in ('open','claimed','in_progress')
  returning id into v_id;
  return v_id;
end $$;

create or replace function admin_task_resolve(
  p_task_id uuid,
  p_resolution jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  update admin_tasks
     set state = 'resolved', resolution = coalesce(p_resolution, '{}'::jsonb), resolved_at = now()
   where id = p_task_id and state not in ('resolved','dismissed')
  returning id into v_id;
  return v_id;
end $$;

create or replace function admin_task_dismiss(
  p_task_id uuid,
  p_reason text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  update admin_tasks
     set state = 'dismissed',
         resolution = jsonb_build_object('dismissed_reason', p_reason),
         resolved_at = now()
   where id = p_task_id and state not in ('resolved','dismissed')
  returning id into v_id;
  return v_id;
end $$;

create or replace function admin_action_log_append(
  p_staff_email text,
  p_tenant_id   uuid,
  p_task_id     uuid,
  p_action      text,
  p_target      text default null,
  p_before      jsonb default null,
  p_after       jsonb default null,
  p_on_behalf   boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_staff_email is null or p_tenant_id is null or p_action is null then
    raise exception 'admin_action_log_append: staff_email, tenant_id, action required'
      using errcode = '22023';
  end if;
  insert into admin_action_log (staff_email, tenant_id, task_id, action, target,
                                before_state, after_state, on_behalf)
  values (p_staff_email, p_tenant_id, p_task_id, p_action, p_target,
          p_before, p_after, coalesce(p_on_behalf, false))
  returning id into v_id;
  return v_id;
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'admin_task_create_once(text,uuid,text,text,uuid,uuid,int)',
    'admin_task_claim(uuid,text)',
    'admin_task_snooze(uuid,timestamptz)',
    'admin_task_resolve(uuid,jsonb)',
    'admin_task_dismiss(uuid,text)',
    'admin_action_log_append(text,uuid,uuid,text,text,jsonb,jsonb,boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;

commit;
