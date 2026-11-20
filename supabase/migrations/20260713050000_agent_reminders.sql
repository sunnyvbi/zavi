
create table agent_reminders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,

  created_by uuid references auth.users(id) on delete set null,
  slack_user_id text,

  agent_slug text not null,

  mode text not null check (mode in ('ping', 'run')),

  note text not null check (length(note) between 1 and 2000),

  schedule_kind text not null check (schedule_kind in ('once', 'recurring')),

  due_at timestamptz not null,

  cron_expression text,

  tz text not null default 'UTC',

  deliver jsonb not null,

  status text not null default 'pending'
    check (status in ('pending', 'fired', 'cancelled', 'failed')),

  lease_until timestamptz,

  last_fired_at timestamptz,
  fired_count int not null default 0,
  last_error text,

  created_at timestamptz not null default now(),

  constraint agent_reminders_cron_shape check (
    (schedule_kind = 'recurring' and cron_expression is not null) or
    (schedule_kind = 'once' and cron_expression is null)
  )
);

create index agent_reminders_due_idx
  on agent_reminders (due_at)
  where status = 'pending';

create index agent_reminders_tenant_idx
  on agent_reminders (tenant_id, status, due_at);

alter table agent_reminders enable row level security;

create policy agent_reminders_select on agent_reminders
  for select to authenticated using (
    tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
  );
create policy agent_reminders_active_tenant_restrict
  on agent_reminders as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

create or replace function create_agent_reminder(
  p_tenant_id uuid,
  p_agent_slug text,
  p_mode text,
  p_note text,
  p_schedule_kind text,
  p_due_at timestamptz,
  p_cron_expression text,
  p_tz text,
  p_deliver jsonb,
  p_created_by uuid default null,
  p_slack_user_id text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pending int;
  v_id uuid;
begin
  select count(*) into v_pending
    from agent_reminders
   where tenant_id = p_tenant_id
     and status = 'pending';

  if v_pending >= 50 then
    raise exception 'reminder cap reached: % pending reminders for this workspace. Cancel one first.', v_pending
      using errcode = '22023';
  end if;

  if p_due_at <= now() - interval '1 minute' then
    raise exception 'due_at is in the past' using errcode = '22023';
  end if;

  insert into agent_reminders (
    tenant_id, created_by, slack_user_id, agent_slug, mode, note,
    schedule_kind, due_at, cron_expression, tz, deliver
  ) values (
    p_tenant_id, p_created_by, p_slack_user_id, p_agent_slug, p_mode, p_note,
    p_schedule_kind, p_due_at, p_cron_expression, coalesce(p_tz, 'UTC'), p_deliver
  ) returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function create_agent_reminder(uuid, text, text, text, text, timestamptz, text, text, jsonb, uuid, text) from public, anon, authenticated;
grant execute on function create_agent_reminder(uuid, text, text, text, text, timestamptz, text, text, jsonb, uuid, text) to service_role;

create or replace function claim_due_reminders(p_limit int default 50)
returns setof agent_reminders
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  update agent_reminders r
     set lease_until = now() + interval '2 minutes'
   where r.id in (
     select id from agent_reminders
      where status = 'pending'
        and due_at <= now()
        and (lease_until is null or lease_until < now())
      order by due_at
      limit p_limit
      for update skip locked
   )
  returning r.*;
end;
$$;

revoke execute on function claim_due_reminders(int) from public, anon, authenticated;
grant execute on function claim_due_reminders(int) to service_role;

create or replace function claim_reminder_by_id(p_reminder_id uuid)
returns setof agent_reminders
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  update agent_reminders r
     set lease_until = now() + interval '2 minutes'
   where r.id = (
     select id from agent_reminders
      where id = p_reminder_id
        and status = 'pending'
        and due_at <= now()
        and (lease_until is null or lease_until < now())
      for update skip locked
   )
  returning r.*;
end;
$$;

revoke execute on function claim_reminder_by_id(uuid) from public, anon, authenticated;
grant execute on function claim_reminder_by_id(uuid) to service_role;

create or replace function cancel_agent_reminder(p_tenant_id uuid, p_reminder_id uuid)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rows int;
begin
  update agent_reminders
     set status = 'cancelled'
   where id = p_reminder_id
     and tenant_id = p_tenant_id
     and status = 'pending';
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke execute on function cancel_agent_reminder(uuid, uuid) from public, anon, authenticated;
grant execute on function cancel_agent_reminder(uuid, uuid) to service_role;

update decision_classes
   set default_autonomy = 'auto',
       description = description || ' (approval gate retired 2026-07-13: the same scheduling capability is reachable un-gated via praxis__remind; one door, one authority model)'
 where slug in ('operator.create-standing-order', 'research.create-watch')
   and default_autonomy = 'approval';
