
create table if not exists tenant_local_lane (
  tenant_id       uuid primary key references tenants(id) on delete cascade,
  enabled         boolean not null default false,
  last_drained_at timestamptz,
  updated_by      text,
  updated_at      timestamptz not null default now()
);

alter table tenant_local_lane enable row level security;

drop policy if exists tenant_local_lane_select on tenant_local_lane;
create policy tenant_local_lane_select on tenant_local_lane
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = tenant_local_lane.tenant_id)
  );

create or replace function set_tenant_local_lane(
  p_tenant_id  uuid,
  p_enabled    boolean,
  p_updated_by text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into tenant_local_lane (tenant_id, enabled, updated_by, updated_at)
  values (p_tenant_id, p_enabled, p_updated_by, now())
  on conflict (tenant_id) do update
    set enabled = excluded.enabled,
        updated_by = excluded.updated_by,
        updated_at = now();

  if p_enabled is not true then
    update agent_work_items
       set lane = 'e2b',
           status = case when status = 'leased' then 'pending' else status end,
           lease_owner = case when status = 'leased' then null else lease_owner end,
           lease_expires_at = case when status = 'leased' then null else lease_expires_at end,
           updated_at = now()
     where tenant_id = p_tenant_id
       and lane = 'local'
       and (
         status = 'pending'
         or (status = 'leased' and lease_expires_at is not null and lease_expires_at < now())
       );
  end if;
end $$;
revoke all on function set_tenant_local_lane(uuid, boolean, text) from public;
grant execute on function set_tenant_local_lane(uuid, boolean, text) to service_role;

create or replace function touch_tenant_local_lane_drained(
  p_tenant_id uuid
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into tenant_local_lane (tenant_id, enabled, last_drained_at, updated_at)
  values (p_tenant_id, false, now(), now())
  on conflict (tenant_id) do update
    set last_drained_at = now();
end $$;
revoke all on function touch_tenant_local_lane_drained(uuid) from public;
grant execute on function touch_tenant_local_lane_drained(uuid) to service_role;
