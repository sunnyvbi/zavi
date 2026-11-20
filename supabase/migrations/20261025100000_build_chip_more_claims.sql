
begin;

create table if not exists public.build_chip_more_claims (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  build_id uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists build_chip_more_claims_tenant_created_idx
  on public.build_chip_more_claims (tenant_id, created_at);
create index if not exists build_chip_more_claims_tenant_build_idx
  on public.build_chip_more_claims (tenant_id, build_id);

alter table public.build_chip_more_claims enable row level security;
revoke all on table public.build_chip_more_claims from public, anon, authenticated;

comment on table public.build_chip_more_claims is
  'One row per free "+ more suggestions" model call. Written only by claim_build_chip_more.';

create or replace function public.claim_build_chip_more(
  p_tenant_id uuid,
  p_build_id uuid,
  p_per_build integer,
  p_per_day integer
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null or p_build_id is null or coalesce(p_per_build, 0) < 1 or coalesce(p_per_day, 0) < 1 then
    return false;
  end if;
  if auth.uid() is not null and not exists (
    select 1 from public.tenant_users tu where tu.user_id = auth.uid() and tu.tenant_id = p_tenant_id
  ) then
    return false;
  end if;
  p_per_build := least(p_per_build, 5);
  p_per_day := least(p_per_day, 30);
  perform pg_advisory_xact_lock(hashtextextended('chip-more:' || p_tenant_id::text, 0));
  if not exists (
    select 1 from public.conductor_runs c
     where c.id = p_build_id and c.tenant_id = p_tenant_id and c.kind = 'build_app'
  ) then
    return false;
  end if;
  if (select count(*) from public.build_chip_more_claims
       where tenant_id = p_tenant_id and build_id = p_build_id) >= p_per_build then
    return false;
  end if;
  if (select count(*) from public.build_chip_more_claims
       where tenant_id = p_tenant_id and created_at > now() - interval '24 hours') >= p_per_day then
    return false;
  end if;
  insert into public.build_chip_more_claims (tenant_id, build_id) values (p_tenant_id, p_build_id);
  return true;
end $$;

revoke all on function public.claim_build_chip_more(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_build_chip_more(uuid, uuid, integer, integer) to authenticated, service_role;

commit;
