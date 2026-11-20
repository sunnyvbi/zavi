
create table if not exists tenant_retention_policy (
  tenant_id    uuid primary key references tenants(id) on delete cascade,
  raw_ttl_days int check (raw_ttl_days is null or (raw_ttl_days >= 0 and raw_ttl_days <= 3650)),
  store_raw    boolean not null default true,
  updated_by   text,
  updated_at   timestamptz not null default now()
);

alter table tenant_retention_policy enable row level security;

drop policy if exists tenant_retention_policy_select on tenant_retention_policy;
create policy tenant_retention_policy_select on tenant_retention_policy
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = tenant_retention_policy.tenant_id)
  );

create or replace function set_tenant_retention_policy(
  p_tenant_id    uuid,
  p_raw_ttl_days int default null,
  p_store_raw    boolean default true,
  p_updated_by   text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into tenant_retention_policy (tenant_id, raw_ttl_days, store_raw, updated_by, updated_at)
  values (p_tenant_id, p_raw_ttl_days, p_store_raw, p_updated_by, now())
  on conflict (tenant_id) do update
    set raw_ttl_days = excluded.raw_ttl_days,
        store_raw    = excluded.store_raw,
        updated_by   = excluded.updated_by,
        updated_at   = now();
end $$;
revoke all on function set_tenant_retention_policy(uuid, int, boolean, text) from public;
grant execute on function set_tenant_retention_policy(uuid, int, boolean, text) to service_role;

create or replace function purge_expired_raw_transcripts(
  p_default_ttl_days int default 30,
  p_batch_limit      int default 500
) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  with candidates as (
    select r.id
    from agent_runs r
    left join tenant_retention_policy p on p.tenant_id = r.tenant_id
    where r.finished_at is not null
      and r.finished_at < now() - make_interval(days => coalesce(p.raw_ttl_days, p_default_ttl_days))
      and (r.prompt_snapshot is not null or r.raw_response_text is not null)
    limit p_batch_limit
  )
  update agent_runs r
     set prompt_snapshot   = null,
         raw_response_text = null
    from candidates c
   where r.id = c.id;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function purge_expired_raw_transcripts(int, int) from public;
grant execute on function purge_expired_raw_transcripts(int, int) to service_role;
