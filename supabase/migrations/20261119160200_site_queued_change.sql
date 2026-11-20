begin;

create table if not exists public.site_queued_change (
  site_id          uuid primary key references public.sites(id) on delete cascade,
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  conductor_run_id uuid not null,
  message          text not null check (length(btrim(message)) between 1 and 4000),
  queued_by        uuid,
  status           text not null default 'queued' check (status in ('queued', 'running')),
  queued_at        timestamptz not null default now(),
  claimed_at       timestamptz
);

create index if not exists site_queued_change_tenant_queued_idx
  on public.site_queued_change (tenant_id, queued_at)
  where status = 'queued';

alter table public.site_queued_change enable row level security;
revoke all on public.site_queued_change from anon, authenticated;

create or replace function public.site_queued_change_prune(p_tenant_id uuid) returns void
language sql security definer
set search_path = pg_catalog, pg_temp as $$
  delete from public.site_queued_change q
   where q.tenant_id = p_tenant_id
     and (
       q.queued_at < now() - interval '24 hours'
       or (q.status = 'running' and q.claimed_at < now() - interval '15 minutes')
       or (q.status = 'queued' and exists (
             select 1 from public.conductor_runs r
              where r.id = q.conductor_run_id and r.status in ('failed', 'halted')))
     );
$$;

create or replace function public.site_queue_change(
  p_tenant_id        uuid,
  p_site_id          uuid,
  p_conductor_run_id uuid,
  p_message          text,
  p_user_id          uuid default null
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_status text;
begin
  if p_tenant_id is null or p_site_id is null or p_conductor_run_id is null then
    raise exception 'site_queue_change: tenant_id, site_id and conductor_run_id are required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id) then
    raise exception 'site_queue_change: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  perform public.site_queued_change_prune(p_tenant_id);
  select q.status into v_status
    from public.site_queued_change q
   where q.site_id = p_site_id
   for update;
  if v_status = 'running' then
    return 'busy';
  end if;
  insert into public.site_queued_change (site_id, tenant_id, conductor_run_id, message, queued_by, status, queued_at, claimed_at)
  values (p_site_id, p_tenant_id, p_conductor_run_id, btrim(p_message), p_user_id, 'queued', now(), null)
  on conflict (site_id) do update
    set conductor_run_id = excluded.conductor_run_id,
        message = excluded.message,
        queued_by = excluded.queued_by,
        queued_at = now()
  where public.site_queued_change.status = 'queued';
  return case when v_status is null then 'queued' else 'replaced' end;
end $$;

create or replace function public.site_claim_queued_change(
  p_tenant_id uuid
) returns table (site_id uuid, conductor_run_id uuid, message text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null then
    raise exception 'site_claim_queued_change: tenant_id is required' using errcode = '22023';
  end if;
  perform public.site_queued_change_prune(p_tenant_id);
  return query
  update public.site_queued_change q
     set status = 'running',
         claimed_at = now()
   where q.site_id = (
           select n.site_id
             from public.site_queued_change n
            where n.tenant_id = p_tenant_id
              and n.status = 'queued'
            order by n.queued_at
            limit 1
            for update skip locked
         )
     and q.status = 'queued'
  returning q.site_id, q.conductor_run_id, q.message;
end $$;

create or replace function public.site_settle_queued_change(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_requeue   boolean
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'site_settle_queued_change: tenant_id and site_id are required' using errcode = '22023';
  end if;
  if p_requeue then
    update public.site_queued_change q
       set status = 'queued', claimed_at = null
     where q.site_id = p_site_id and q.tenant_id = p_tenant_id and q.status = 'running';
  else
    delete from public.site_queued_change q
     where q.site_id = p_site_id and q.tenant_id = p_tenant_id and q.status = 'running';
  end if;
end $$;

create or replace function public.site_discard_queued_change(
  p_tenant_id        uuid,
  p_conductor_run_id uuid
) returns integer
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_count integer;
begin
  if p_tenant_id is null or p_conductor_run_id is null then
    raise exception 'site_discard_queued_change: tenant_id and conductor_run_id are required' using errcode = '22023';
  end if;
  delete from public.site_queued_change q
   where q.tenant_id = p_tenant_id and q.conductor_run_id = p_conductor_run_id and q.status = 'queued';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.site_queued_change_prune(uuid) from public, anon, authenticated;
grant execute on function public.site_queued_change_prune(uuid) to service_role;
revoke all on function public.site_discard_queued_change(uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_discard_queued_change(uuid, uuid) to service_role;
revoke all on function public.site_queue_change(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.site_queue_change(uuid, uuid, uuid, text, uuid) to service_role;
revoke all on function public.site_claim_queued_change(uuid) from public, anon, authenticated;
grant execute on function public.site_claim_queued_change(uuid) to service_role;
revoke all on function public.site_settle_queued_change(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.site_settle_queued_change(uuid, uuid, boolean) to service_role;

commit;
