
begin;

create table if not exists competitor_snapshots (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants(id) on delete cascade,
  week_bucket   date        not null,
  landscape     jsonb       not null,
  delta         jsonb,
  source_run_id uuid,
  created_at    timestamptz not null default now(),
  unique (tenant_id, week_bucket)
);

create index if not exists competitor_snapshots_tenant_idx
  on competitor_snapshots (tenant_id);

alter table competitor_snapshots enable row level security;
drop policy if exists competitor_snapshots_select on competitor_snapshots;
create policy competitor_snapshots_select on competitor_snapshots
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = competitor_snapshots.tenant_id)
  );
revoke insert, update, delete on competitor_snapshots from authenticated, anon;

create or replace function upsert_competitor_snapshot(
  p_tenant_id     uuid,
  p_week_bucket   date,
  p_landscape     jsonb,
  p_delta         jsonb,
  p_source_run_id uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if p_tenant_id is null then
    raise exception 'upsert_competitor_snapshot: null tenant_id' using errcode = '22023';
  end if;
  if p_week_bucket is null then
    raise exception 'upsert_competitor_snapshot: null week_bucket' using errcode = '22023';
  end if;
  if p_landscape is null then
    raise exception 'upsert_competitor_snapshot: null landscape' using errcode = '22023';
  end if;

  insert into competitor_snapshots (tenant_id, week_bucket, landscape, delta, source_run_id)
  values (p_tenant_id, p_week_bucket, p_landscape, p_delta, p_source_run_id)
  on conflict (tenant_id, week_bucket)
  do update set
    landscape     = excluded.landscape,
    delta         = excluded.delta,
    source_run_id = excluded.source_run_id
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function upsert_competitor_snapshot(uuid, date, jsonb, jsonb, uuid) from public;
revoke execute on function upsert_competitor_snapshot(uuid, date, jsonb, jsonb, uuid) from authenticated, anon;
grant execute on function upsert_competitor_snapshot(uuid, date, jsonb, jsonb, uuid) to service_role;

commit;
