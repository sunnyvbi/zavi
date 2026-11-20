
create table if not exists perf_dashboard_snapshots (
  tenant_id       uuid        not null references tenants(id) on delete cascade,
  "window"         text        not null,
  payload         jsonb       not null,
  schema_version  int         not null default 1,
  fetched_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (tenant_id, "window"),
  constraint perf_dashboard_snapshots_window_chk
    check ("window" in ('last_7d','last_14d','last_28d','last_30d','this_month','last_month'))
);

alter table perf_dashboard_snapshots enable row level security;

create or replace function get_perf_dashboard_snapshot(
  p_tenant_id uuid,
  p_window    text
) returns table (payload jsonb, schema_version int, fetched_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_tenant_id is null then
    raise exception 'tenant_id required';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of tenant %', p_tenant_id;
  end if;

  return query
    select s.payload, s.schema_version, s.fetched_at
    from perf_dashboard_snapshots s
    where s.tenant_id = p_tenant_id and s."window" = p_window;
end;
$$;

create or replace function upsert_perf_dashboard_snapshot(
  p_tenant_id      uuid,
  p_window         text,
  p_payload        jsonb,
  p_schema_version int default 1
) returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fetched_at timestamptz;
begin
  if p_tenant_id is null then
    raise exception 'tenant_id required';
  end if;
  if p_window not in ('last_7d','last_14d','last_28d','last_30d','this_month','last_month') then
    raise exception 'bad window %', p_window;
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of tenant %', p_tenant_id;
  end if;

  insert into perf_dashboard_snapshots (tenant_id, "window", payload, schema_version, fetched_at, updated_at)
  values (p_tenant_id, p_window, p_payload, coalesce(p_schema_version, 1), now(), now())
  on conflict (tenant_id, "window") do update
    set payload        = excluded.payload,
        schema_version = excluded.schema_version,
        fetched_at     = now(),
        updated_at     = now()
  returning fetched_at into v_fetched_at;

  return v_fetched_at;
end;
$$;

revoke all on function get_perf_dashboard_snapshot(uuid, text) from public, anon;
revoke all on function upsert_perf_dashboard_snapshot(uuid, text, jsonb, int) from public, anon;
grant execute on function get_perf_dashboard_snapshot(uuid, text) to authenticated;
grant execute on function upsert_perf_dashboard_snapshot(uuid, text, jsonb, int) to authenticated;
