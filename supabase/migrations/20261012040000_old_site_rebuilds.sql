
create table if not exists public.old_site_rebuilds (
  tenant_id               uuid primary key references public.tenants(id) on delete cascade,
  source_conductor_run_id uuid,
  claim_token             uuid not null,
  conductor_run_id        uuid,
  claimed_at              timestamptz not null default now(),
  settled_at              timestamptz
);
alter table public.old_site_rebuilds enable row level security;
revoke all on public.old_site_rebuilds from public, anon, authenticated;

create or replace function public.claim_old_site_rebuild(
  p_tenant_id      uuid,
  p_source_run_id  uuid,
  p_stale_seconds  integer
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_row    public.old_site_rebuilds%rowtype;
  v_token  uuid := gen_random_uuid();
  v_status text;
begin
  if p_tenant_id is null then
    raise exception 'claim_old_site_rebuild: tenant_id required' using errcode = '22023';
  end if;

  insert into public.old_site_rebuilds (tenant_id, source_conductor_run_id, claim_token)
  values (p_tenant_id, p_source_run_id, v_token)
  on conflict (tenant_id) do nothing;

  select * into v_row from public.old_site_rebuilds r where r.tenant_id = p_tenant_id for update;
  if v_row.claim_token = v_token then
    return jsonb_build_object('outcome', 'claimed', 'token', v_token);
  end if;

  if v_row.conductor_run_id is not null then
    select c.status into v_status
      from public.conductor_runs c
     where c.id = v_row.conductor_run_id and c.tenant_id = p_tenant_id;
    if v_status is not null and v_status not in ('failed', 'halted') then
      return jsonb_build_object('outcome', 'existing', 'conductor_run_id', v_row.conductor_run_id);
    end if;
  elsif v_row.claimed_at > now() - make_interval(secs => greatest(coalesce(p_stale_seconds, 300), 30)) then
    return jsonb_build_object('outcome', 'starting');
  end if;

  update public.old_site_rebuilds
     set claim_token = v_token,
         source_conductor_run_id = p_source_run_id,
         conductor_run_id = null,
         claimed_at = now(),
         settled_at = null
   where tenant_id = p_tenant_id;
  return jsonb_build_object('outcome', 'claimed', 'token', v_token);
end;
$$;

create or replace function public.settle_old_site_rebuild(
  p_tenant_id        uuid,
  p_token            uuid,
  p_conductor_run_id uuid
) returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_n integer;
begin
  update public.old_site_rebuilds r
     set conductor_run_id = p_conductor_run_id, settled_at = now()
   where r.tenant_id = p_tenant_id
     and r.claim_token = p_token
     and r.conductor_run_id is null
     and exists (
       select 1 from public.conductor_runs c where c.id = p_conductor_run_id and c.tenant_id = p_tenant_id
     );
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

create or replace function public.release_old_site_rebuild(
  p_tenant_id uuid,
  p_token     uuid
) returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_n integer;
begin
  delete from public.old_site_rebuilds
   where tenant_id = p_tenant_id and claim_token = p_token and conductor_run_id is null;
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

revoke all on function public.claim_old_site_rebuild(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.settle_old_site_rebuild(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_old_site_rebuild(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_old_site_rebuild(uuid, uuid, integer) to service_role;
grant execute on function public.settle_old_site_rebuild(uuid, uuid, uuid) to service_role;
grant execute on function public.release_old_site_rebuild(uuid, uuid) to service_role;
