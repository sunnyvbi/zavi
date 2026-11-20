
create table if not exists public.live_source_hourly (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hour timestamptz not null,
  metric text not null check (metric ~ '^[a-z][a-z0-9_]{0,39}$'),
  value integer not null check (value >= 0),
  primary key (tenant_id, hour, metric)
);

create table if not exists public.live_source_push (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  covered_from timestamptz not null,
  covered_to timestamptz not null,
  metrics text[] not null default '{}',
  pushed_at timestamptz not null default now(),
  check (covered_from < covered_to)
);

alter table public.live_source_hourly enable row level security;
alter table public.live_source_push enable row level security;
revoke all on public.live_source_hourly from public, anon, authenticated;
revoke all on public.live_source_push from public, anon, authenticated;

create or replace function public.live_source_replace(
  p_tenant_id uuid, p_from timestamptz, p_to timestamptz, p_metrics text[], p_rows jsonb
) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n integer;
begin
  if p_from >= p_to then raise exception 'bad_window'; end if;
  if exists (select 1 from public.live_source_push where tenant_id = p_tenant_id and covered_to > p_to) then
    return -1;
  end if;
  delete from public.live_source_hourly
   where tenant_id = p_tenant_id and hour >= p_from and hour < p_to;
  insert into public.live_source_hourly (tenant_id, hour, metric, value)
  select p_tenant_id, (r->>'hour')::timestamptz, m.key, (m.value #>> '{}')::integer
    from jsonb_array_elements(p_rows) as r, jsonb_each(r->'metrics') as m
   where (r->>'hour')::timestamptz >= p_from and (r->>'hour')::timestamptz < p_to
     and m.key = any(p_metrics);
  get diagnostics v_n = row_count;
  insert into public.live_source_push (tenant_id, covered_from, covered_to, metrics, pushed_at)
  values (p_tenant_id, p_from, p_to, p_metrics, now())
  on conflict (tenant_id) do update
     set covered_from = excluded.covered_from, covered_to = excluded.covered_to,
         metrics = excluded.metrics, pushed_at = now();
  return v_n;
end $$;
revoke all on function public.live_source_replace(uuid,timestamptz,timestamptz,text[],jsonb) from public, anon, authenticated;
grant execute on function public.live_source_replace(uuid,timestamptz,timestamptz,text[],jsonb) to service_role;
