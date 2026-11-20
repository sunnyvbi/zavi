
create table if not exists custom_agent_handoff_joins (
  parent_run_id uuid primary key references agent_runs(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  child_run_ids uuid[] not null default '{}',
  status text not null default 'open'
    check (status in ('open', 'waiting', 'delivering', 'delivered', 'cancelled')),
  lease_until timestamptz,
  attempts int not null default 0,
  parent_output text check (parent_output is null or length(parent_output) <= 200000),
  deadline_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(child_run_ids) <= 10)
);

create index if not exists custom_agent_handoff_joins_tenant_idx
  on custom_agent_handoff_joins (tenant_id);

alter table custom_agent_handoff_joins enable row level security;
revoke all on table custom_agent_handoff_joins from public, anon, authenticated;

create or replace function custom_agent_handoff_register(
  p_tenant_id uuid, p_parent_run_id uuid, p_child_run_id uuid
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ok boolean;
begin
  if p_tenant_id is null or p_parent_run_id is null or p_child_run_id is null
     or p_parent_run_id = p_child_run_id then
    return false;
  end if;
  select exists (
    select 1 from agent_runs p
     where p.id = p_parent_run_id
       and p.tenant_id = p_tenant_id
       and p.trigger = 'cron'
       and _is_custom_agent_run(p_tenant_id, p.agent_slug, p.id, p.cron_dedupe_key)
  ) and exists (
    select 1 from agent_runs c
     where c.id = p_child_run_id and c.tenant_id = p_tenant_id
  ) into v_ok;
  if not v_ok then
    return false;
  end if;
  insert into custom_agent_handoff_joins (parent_run_id, tenant_id, child_run_ids)
  values (p_parent_run_id, p_tenant_id, array[p_child_run_id])
  on conflict (parent_run_id) do update
    set child_run_ids = case
          when p_child_run_id = any(custom_agent_handoff_joins.child_run_ids)
            then custom_agent_handoff_joins.child_run_ids
          else array_append(custom_agent_handoff_joins.child_run_ids, p_child_run_id)
        end,
        updated_at = now()
    where custom_agent_handoff_joins.tenant_id = p_tenant_id
      and custom_agent_handoff_joins.status = 'open';
  return found;
end $$;

create or replace function custom_agent_handoff_park(
  p_tenant_id uuid, p_parent_run_id uuid, p_output text, p_wait_seconds int
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update custom_agent_handoff_joins
     set status = 'waiting',
         parent_output = left(coalesce(p_output, ''), 200000),
         deadline_at = now() + make_interval(secs => greatest(60, least(coalesce(p_wait_seconds, 1800), 3600))),
         updated_at = now()
   where parent_run_id = p_parent_run_id
     and tenant_id = p_tenant_id
     and status = 'open'
     and cardinality(child_run_ids) > 0;
  return found;
end $$;

create or replace function custom_agent_handoff_claim(
  p_tenant_id uuid, p_parent_run_id uuid
) returns table (parent_output text, child_run_ids uuid[], deadline_at timestamptz, attempts int)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  update custom_agent_handoff_joins j
     set status = 'delivering',
         lease_until = now() + interval '5 minutes',
         attempts = j.attempts + 1,
         updated_at = now()
   where j.parent_run_id = p_parent_run_id
     and j.tenant_id = p_tenant_id
     and (j.status = 'waiting' or (j.status = 'delivering' and j.lease_until < now()))
  returning j.parent_output, j.child_run_ids, j.deadline_at, j.attempts;
end $$;

create or replace function custom_agent_handoff_settle(
  p_tenant_id uuid, p_parent_run_id uuid, p_status text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_status not in ('delivered', 'waiting', 'cancelled') then
    raise exception 'bad status %', p_status using errcode = '22023';
  end if;
  update custom_agent_handoff_joins
     set status = p_status, lease_until = null, updated_at = now()
   where parent_run_id = p_parent_run_id
     and tenant_id = p_tenant_id
     and status = 'delivering';
  return found;
end $$;

create or replace function custom_agent_handoff_cancel(
  p_tenant_id uuid, p_parent_run_id uuid
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update custom_agent_handoff_joins
     set status = 'cancelled', updated_at = now()
   where parent_run_id = p_parent_run_id
     and tenant_id = p_tenant_id
     and status in ('open', 'waiting');
  return found;
end $$;

revoke all on function custom_agent_handoff_register(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function custom_agent_handoff_park(uuid, uuid, text, int) from public, anon, authenticated;
revoke all on function custom_agent_handoff_claim(uuid, uuid) from public, anon, authenticated;
revoke all on function custom_agent_handoff_cancel(uuid, uuid) from public, anon, authenticated;
revoke all on function custom_agent_handoff_settle(uuid, uuid, text) from public, anon, authenticated;
grant execute on function custom_agent_handoff_register(uuid, uuid, uuid) to service_role;
grant execute on function custom_agent_handoff_park(uuid, uuid, text, int) to service_role;
grant execute on function custom_agent_handoff_claim(uuid, uuid) to service_role;
grant execute on function custom_agent_handoff_cancel(uuid, uuid) to service_role;
grant execute on function custom_agent_handoff_settle(uuid, uuid, text) to service_role;
